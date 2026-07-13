#!/usr/bin/env bash
set -Eeuo pipefail

# Run this on the legacy Track the Hack VM during the production maintenance
# window. It deliberately leaves the old web process stopped after a successful
# import so writes cannot diverge before the Cloudflare route is switched.

SOURCE_CONTAINER="${SOURCE_CONTAINER:-track-the-hack-db}"
SOURCE_DATABASE="${SOURCE_DATABASE:-track-the-hack}"
DESTINATION_HOST="${DESTINATION_HOST:-track-the-hack-mysql-ce.mysql.database.azure.com}"
DESTINATION_USER="${DESTINATION_USER:-trackadmin}"
DESTINATION_DATABASE="${DESTINATION_DATABASE:-track_the_hack}"
PM2="${PM2:-/home/azure/.nvm/versions/node/v20.15.1/bin/pm2}"
PM2_APP="${PM2_APP:-track-the-hack}"

dump_file="$(mktemp /tmp/track-the-hack-mysql.XXXXXX.sql)"
mysql_env_file="$(mktemp /tmp/track-the-hack-mysql-env.XXXXXX)"
web_stopped=false
migration_complete=false
destination_password=""

cleanup() {
	rm -f "$dump_file"
	rm -f "$mysql_env_file"
	unset destination_password
	if [[ "$web_stopped" == true && "$migration_complete" != true ]]; then
		"$PM2" start "$PM2_APP" >/dev/null || true
		echo "Migration failed; the legacy web process was restarted." >&2
	fi
}
trap cleanup EXIT

if [[ ! -t 0 ]]; then
	echo "Run this script from an interactive terminal so the destination password is not recorded." >&2
	exit 1
fi

docker inspect "$SOURCE_CONTAINER" >/dev/null
getent hosts "$DESTINATION_HOST" >/dev/null
timeout 5 bash -c "</dev/tcp/$DESTINATION_HOST/3306"

read -r -s -p "Managed MySQL password for $DESTINATION_USER: " destination_password
echo
printf 'MYSQL_PWD=%s\n' "$destination_password" >"$mysql_env_file"
unset destination_password

docker exec --env-file "$mysql_env_file" "$SOURCE_CONTAINER" \
	mysql --ssl-mode=VERIFY_IDENTITY -h "$DESTINATION_HOST" -u "$DESTINATION_USER" \
	-e "SELECT 1" >/dev/null

"$PM2" stop "$PM2_APP"
web_stopped=true

docker exec "$SOURCE_CONTAINER" sh -lc \
	'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick --triggers --routines --events --hex-blob --set-gtid-purged=OFF --no-tablespaces --default-character-set=utf8mb4 "$1"' \
	sh "$SOURCE_DATABASE" >"$dump_file"

if [[ ! -s "$dump_file" ]]; then
	echo "The source dump is empty." >&2
	exit 1
fi

docker exec --env-file "$mysql_env_file" "$SOURCE_CONTAINER" \
	mysql --ssl-mode=VERIFY_IDENTITY -h "$DESTINATION_HOST" -u "$DESTINATION_USER" \
	-e "DROP DATABASE IF EXISTS \`$DESTINATION_DATABASE\`; CREATE DATABASE \`$DESTINATION_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

docker exec -i --env-file "$mysql_env_file" "$SOURCE_CONTAINER" \
	mysql --ssl-mode=VERIFY_IDENTITY -h "$DESTINATION_HOST" -u "$DESTINATION_USER" \
	"$DESTINATION_DATABASE" <"$dump_file"

mapfile -t tables < <(docker exec "$SOURCE_CONTAINER" sh -lc \
	'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SHOW TABLES" "$1"' \
	sh "$SOURCE_DATABASE")

for table in "${tables[@]}"; do
	if [[ ! "$table" =~ ^[A-Za-z0-9_]+$ ]]; then
		echo "Refusing to interpolate unexpected table name: $table" >&2
		exit 1
	fi
	source_count="$(docker exec "$SOURCE_CONTAINER" sh -lc \
		'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SELECT COUNT(*) FROM \`$2\`" "$1"' \
		sh "$SOURCE_DATABASE" "$table")"
	destination_count="$(docker exec --env-file "$mysql_env_file" "$SOURCE_CONTAINER" \
		mysql --ssl-mode=VERIFY_IDENTITY -h "$DESTINATION_HOST" -u "$DESTINATION_USER" \
		-N -B -e "SELECT COUNT(*) FROM \`$table\`" "$DESTINATION_DATABASE")"
	if [[ "$source_count" != "$destination_count" ]]; then
		echo "Row-count mismatch for $table: source=$source_count destination=$destination_count" >&2
		exit 1
	fi
	printf '%-32s %s\n' "$table" "$source_count"
done

migration_complete=true
echo "Migration and exact per-table row-count validation succeeded."
echo "The legacy web process remains stopped. Complete the Cloudflare route switch now."
