# Run inside the OpenProject application container with Rails runner. Redirect
# stdout directly to a mode-600 file: it contains the newly generated API token.
require "securerandom"

login = ENV.fetch("INTEGRATION_LOGIN", "track-the-hack-bot")
mail = ENV.fetch("INTEGRATION_EMAIL", "track-the-hack-bot@hackthehill.com")
project_ids = ENV.fetch("INTEGRATION_PROJECT_IDS", "3,7,9,10,11,13,15,18,24")
                 .split(",").map { |value| Integer(value, 10) }.uniq

user = User.find_or_initialize_by(login:)
if user.new_record?
  password = SecureRandom.base64(64)
  user.assign_attributes(
    firstname: "Track the Hack",
    lastname: "Discord Bot",
    mail:,
    admin: false,
    status: :active,
    password:,
    password_confirmation: password,
    force_password_change: false
  )
  user.save!
elsif user.admin?
  raise "Refusing to use an administrator account for the Discord integration."
end

permissions = %i[
  search_project
  view_project
  view_project_attributes
  view_members
  view_work_packages
  add_work_packages
  edit_work_packages
  add_work_package_comments
  work_package_assigned
]
role = ProjectRole.find_or_initialize_by(name: "Discord task integration")
role.permissions = permissions
role.save!

projects = Project.active.where(id: project_ids).to_a
missing = project_ids - projects.map(&:id)
raise "Unknown or inactive project IDs: #{missing.join(', ')}" if missing.any?

projects.each do |project|
  member = Member.find_or_initialize_by(project:, principal: user)
  member.roles = [role]
  member.save!
end

Token::API.where(user:).where("data ->> 'token_name' = ?", "Track the Hack Discord bot").delete_all
token = Token::API.create!(user:, token_name: "Track the Hack Discord bot")
STDOUT.write(token.plain_value)
