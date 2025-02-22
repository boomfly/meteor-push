/* globals Package, Npm, Cordova */
Package.describe({
  name: 'activitree:push',
  version: '3.0.0',
  summary: 'Push Notifications for Cordova and Web/PWA with Firebase (FCM).',
  git: 'https://github.com/activitree/meteor-push.git'
})

Npm.depends({
  'firebase-admin': '13.1.0',
  firebase: '11.3.1',
  events: '3.3.0'
})

Cordova.depends({
  '@havesource/cordova-plugin-push': 'https://github.com/boomfly/cordova-plugin-push.git#d64c795be7cf47b0eec08645981d0226c8b7aa7e',
  // '@havesource/cordova-plugin-push': 'file://./imports/ui/lib/cordova-plugin-push',
  'cordova-plugin-device': '2.0.3'
})

Package.onUse(api => {
  api.versionsFrom(['2.14', '3.0'])

  api.use(['tracker', 'reactive-var'], ['web.browser', 'web.cordova'])
  api.use(['accounts-base'], ['web.browser', 'web.cordova', 'server'])

  api.use([
    'ecmascript',
    'check',
    'mongo',
    'ejson',
    'random'
  ], ['client', 'server'])

  api.use('mongo', 'server')

  // API's
  api.mainModule('lib/server/index.js', 'server')

  api.mainModule('lib/client/cordova.js', ['web.cordova'])
  api.mainModule('lib/client/web.js', ['web.browser'])
})
