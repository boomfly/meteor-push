/* globals Notification */
import firebase from 'firebase/app'
import 'firebase/messaging'
import EventEmitter from 'events'

/* globals Package */
import { Meteor } from 'meteor/meteor'
import { Tracker } from 'meteor/tracker'

const noop = function() {}

const packageName = module.id.startsWith("/node_modules/meteor/")
  ? module.id.split("/")[3]
  : null

const deviceStorage = window.localStorage
const addUserId = Boolean(Package['accounts-base'])

const interpretError = err => {
  // eslint-disable-next-line no-prototype-builtins
  if (err.hasOwnProperty('code') && err.code === 'messaging/permission-default') {
    return 'You need to allow the site to send notifications'
    // eslint-disable-next-line no-prototype-builtins
  } else if (err.hasOwnProperty('code') && err.code === 'messaging/permission-blocked') {
    return 'Currently, the site is blocked from sending notifications. Please unblock the same in your browser settings'
  } else {
    return 'Unable to subscribe you to notifications'
  }
}

class WebPushHandle extends EventEmitter {
  constructor () {
    super()
    this.configured = false
    this.configuration = {}
    if ('Notification' in window) {
      this._permission = new ReactiveVar(Notification.permission)
    } else {
      this._permission = {}
    }
  }

  isPushSupported() { return firebase.messaging.isSupported() }

  hasConfig() {
    return (
      this.configuration.firebase !== null && this.configuration.firebase !== undefined &&
      this.configuration.publicVapidKey !== null && this.configuration.publicVapidKey !== undefined
    )
  }

  permission() { return this._permission.get() }

  setConsole(isDebug) {
    self = this
    if (isDebug) {
      this.console = {
        log: console.log.bind(console, `${packageName}:`),
        error: console.error.bind(console, `${packageName}:`)
      }
    } else {
      this.console = {
        log: noop,
        error: noop
      }
    }
  }

  Configure (configuration = {}) {
    this.setConsole(configuration.debug)
    
    if (this.configured) {
      this.console.error('Push.Error: "Push.Configure may only be called once"')
      throw new Error('Push.Configure may only be called once')
    }

    this.configuration = configuration
    this._storage = this._getStorage()

    this.console.log('WebPushHandle.Configure:', configuration)
    this.configured = true

    Meteor.startup(() => {
      const isFacebookApp = () => {
        const ua = navigator.userAgent || navigator.vendor || window.opera
        return (ua.indexOf('FBAN') > -1) || (ua.indexOf('FBAV') > -1)
      }

      // If no Firebase configuration, register sw.js
      // Otherwise register '/firebase-messaging-sw.js' which includes the sw.js
      const doTabsRefresh = () => {
        // Refresh all tabs after a service worker update takes place
        let refreshing
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (refreshing) { return }
          refreshing = true
          window.location.reload()
        })
      }

      const isServiceWorkerSupported = 'serviceWorker' in navigator

      // this.console.log(isServiceWorkerSupported, this.hasConfig(), this.isPushSupported())

      if (isServiceWorkerSupported && !isFacebookApp()) {
        if (!this.hasConfig() || !this.isPushSupported()) {
          this.console.log('Firebase configuration is required: \'messagingSenderId\' and a \'PublicVapidKey\'')
          navigator.serviceWorker.register('/sw.js')
            .then(registration => {
              this.console.log('sw-basic')
            })
            .catch(err => {
              this.console.log('ServiceWorker registration failed: ', err)
            })
          doTabsRefresh()
          return false
        }

        if (this.hasConfig() && this.isPushSupported()) {
          const firebaseApp = firebase.initializeApp(this.configuration.firebase)
          this.messaging = firebaseApp.messaging()
          // this.messaging.usePublicVapidKey(configuration.publicVapidKey)

          window.addEventListener('load', async () => {
            // this.registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
            //   updateViaCache: 'none'
            // })
            // this.messaging.useServiceWorker(this.registration)
            // this.emit('registration', this.registration)
            // Refresh all tabs after a service worker update takes place
            doTabsRefresh()

            /**
             * Listen for the foreground messages. Background messages will be dealt with by the worker
             */

            this.messaging.onMessage(payload => {
              this.console.log('My Foreground Message payload here: ', payload)
              this.emit('message', payload)
              const title = payload.notification.title
              let tag = null
              if (payload.data && payload.data.tag) {
                tag = payload.data.tag
              }
              const options = {
                body: payload.notification.body,
                icon: payload.notification.icon,
                image: payload.notification.image,
                action: payload.notification.click_action || payload.fcmOptions.link,
                badge: Meteor.absoluteUrl('images/logo/badge96.png'),
                tag,
                data: payload.data,
                renotify: !!tag
              }
              // this.registration.showNotification(title, options)
              this.console.log('document.hidden', document.hidden)
              if (!document.hidden) {
                this.messaging.swRegistration.showNotification(title, options)
              }
            })

            // TODO see what other listeners I can add here.
          })

          this.messaging.onTokenRefresh(() => {
            // Delete the old Push from MongoDB and from the localStore
            this.unsubscribe()
            this.messaging.getToken({vapidKey: this.configuration.publicVapidKey}).then(token => {
              this.emit('token', token)
            }).catch(err => {
              deviceStorage.setItem('lastSubscriptionMessage', interpretError(err))
            })
          })
        }
      }

      this.subscribe = () => {
        // If the user did not block notifications, request for a token.
        // this.console.log(Notification.permission)
        if (Meteor.isCordova || !this.hasConfig()) {
          return
        }

        if (!this.isPushSupported() || Notification.permission === 'denied') {
          return
        }

        Notification.requestPermission().then(res => {
          if (res === 'denied') {
            deviceStorage.setItem('lastSubscriptionMessage', 'Permission wasn\'t granted. Allow a retry.')
            return
          }
          if (res === 'default') {
            deviceStorage.setItem('lastSubscriptionMessage', 'The permission request was dismissed.')
            return
          }
          this.messaging.getToken({vapidKey: configuration.publicVapidKey}).then(token => {
            this.console.log('Calling subscribe')
            if (token) {
              this.emit('token', token)
            } else {
              deviceStorage.setItem('lastSubscriptionMessage', 'No Instance ID token available. Request permission to generate one.')
            }
          }).catch(err => {
            this.console.log('Error on subscription: ', err)
            this.console.log('WebPush error when asking for permission', interpretError(err))
          })
        })
      }

      this.unsubscribe = () => {
        const {_id} = this._storage
        // const pushTokenId = deviceStorage.getItem('pushTokenId')
        if (!_id || !this.isPushSupported()) {
          return
        }
        Meteor.call('push-unsub-webpush', pushTokenId, err => {
          if (err) {
            this.console.error('Could not save this token to DB: ', err)
          } else {
            this._setStorage({
              _id: null,
              token: null
            })
            // deviceStorage.removeItem('WebPush-Subscribed')
            // deviceStorage.removeItem('pushTokenId')
            // deviceStorage.removeItem('token')
          }
        })
      }
    })

    const initPushUpdates = appName => {
      Meteor.startup(() => {
        this.on('token', token => {
          const data = {
            token: { web: token },
            appName,
            userId: Meteor.userId() || null
          }
          Meteor.call('push-update', data, (err, res) => {
            if (err) {
              return this.console.error('Could not save this token to DB: ', err)
            }
            const { doc } = res
            this._setStorage({
              _id: doc._id,
              token: doc.token.web
            })
            // deviceStorage.setItem('pushTokenId', doc._id)
            // deviceStorage.setItem('token', doc.token.web)
            // deviceStorage.setItem('WebPush-Subscribed', true)
            // deviceStorage.removeItem('lastSubscriptionMessage')
          })
        })

        // TODO Start listening for user updates if accounts package is added
        if (addUserId) {
          Tracker.autorun(() => {
            Meteor.userId()
            // const storedTokenId = deviceStorage.getItem('pushTokenId')
            const {_id} = this._storage

            // TODO check on this logic. This is for when a user logs in on a station after another user. Each user needs to set its own
            // Perhaps compare this with deviceStorage.getItem('WebPush-Subscribed', true)
            // Push context on that machine while the Token of the machine remains the same.
            // Eventually cater to a situation where a user receives certain Notifications, logs out and then receives only "general" notifications.
            if (!this.firstRun) {
              this.console.log('If I see this once, this is the first run.')
              if (_id) {
                // Meteor.call('push-setuser', storedTokenId)
                Meteor.call('push-setuser', _id)
              }
            }
          })
        }
      })
    }
    initPushUpdates(configuration.appName)
  }

  /*
      Private methods
    */

  _setStorage = (options) => {
    const {appName} = this.configuration
    Object.assign(this._storage, options)
    deviceStorage.setItem(`${appName.toLowerCase()}.push`, JSON.stringify(this._storage))
  }

  _getStorage = () => {
    const {appName} = this.configuration
    let storage
    try {
      storage = JSON.parse(deviceStorage.getItem(`${appName.toLowerCase()}.push`))
    }
    catch(e) {
      this.console.error('Error while loading storage', e)
    }
    return storage || {}
  }

  showNotification(title, options) {
    if (!this.isPushSupported()) {
      return Promise.resolve()
    }
    return this.messaging.swRegistration.showNotification(title, options)
  }

  async getNotifications(options) {
    if (!this.isPushSupported()) {
      return Promise.resolve([])
    }
    return await this.messaging.swRegistration.getNotifications(options)
  }
}

const WebPush = new WebPushHandle()
export default WebPush

const webPushConfigure = () => {
  // return WebPush.Configure()
}

function webPushSubscribe () {
  return WebPush.subscribe()
}

const webPushUnsubscribe = () => {
  return WebPush.unsubscribe()
}

export { webPushSubscribe, webPushUnsubscribe, webPushConfigure }
