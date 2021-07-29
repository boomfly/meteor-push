
export const PACKAGE_NAME = module.id.startsWith("/node_modules/meteor/")
  ? module.id.split("/")[3]
  : null

export const UPDATE_METHOD_NAME = `${PACKAGE_NAME}.update`
export const SET_USER_METHOD_NAME = `${PACKAGE_NAME}.setUser`

export const ANONYMOUS_TOPIC = 'anonymous'
export const AUTHENTICATED_TOPIC = 'authenticated'

export const DefaultTopics = {
  Anonymous: 'anonymous',
  Authenticated: 'authenticated'
}