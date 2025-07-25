/* globals Notification */
import firebase, {initializeApp} from 'firebase/app'
import {getMessaging, onMessage, getToken, deleteToken, isSupported} from 'firebase/messaging'
// import 'firebase/compat/messaging'
import EventEmitter from 'events'
import {
  PACKAGE_NAME,
  UPDATE_METHOD_NAME
} from '../constants'

/* globals Package */
import { Meteor } from 'meteor/meteor'
import { Tracker } from 'meteor/tracker'

const noop = function() {}

let deviceStorage = {
  getItem: noop,
  setItem: noop
}

try {
  deviceStorage = window.localStorage
} catch (e) {
  console.log(e)
}

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

class WebPush extends EventEmitter {
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

  async config(configuration = {}) {
    this._setConsole(configuration.debug)
    
    if (this.configured) {
      this.console.error('Push.Error: "Push.Configure may only be called once"')
      throw new Error('Push.Configure may only be called once')
    }

    this.configuration = configuration
    this._storage = this._getStorage()

    this.console.log('WebPushHandle.Configure:', configuration)
    this.configured = true

    // this._isPushSupported = await isSupported()
    this._isPushSupported = true
    this._isServiceWorkerSupported = 'serviceWorker' in navigator
    this._hasConfig = (
      this.configuration.firebase !== null && this.configuration.firebase !== undefined &&
      this.configuration.publicVapidKey !== null && this.configuration.publicVapidKey !== undefined
    )
    const ua = navigator.userAgent || navigator.vendor || window.opera
    this._isFacebookApp = (ua.indexOf('FBAN') > -1) || (ua.indexOf('FBAV') > -1)

    // this.console.log(isServiceWorkerSupported, this.hasConfig(), this.isPushSupported())

    if (!this._isServiceWorkerSupported) {
      this.console.error('ServiceWorker not supported')
      return
    }

    if (this._isFacebookApp) {
      this.console.error('FacebookApp not supported')
      return
    }

    if (!this._isPushSupported) {
      this.console.error('Push not supported')
      return
    }

    if (!this._hasConfig) {
      this.console.error('Firebase configuration is required: \'messagingSenderId\' and a \'PublicVapidKey\'')
      return
    }

    const firebaseApp = initializeApp(this.configuration.firebase)
    // const firebaseApp = firebase.initializeApp(this.configuration.firebase)
    // this.messaging = firebaseApp.messaging()
    this.messaging = await getMessaging(firebaseApp)
    
    // this.messaging.usePublicVapidKey(configuration.publicVapidKey)
    // console.log('WebPushHandle: Firebase messaging initialized', this.messaging)

    // Refresh all tabs after a service worker update takes place
    this._listenServiceWorkerControllerChange()

    /**
     * Listen for the foreground messages. Background messages will be dealt with by the worker
     */

    onMessage(this.messaging, async payload => {
      this.console.log('My Foreground Message payload here: ', payload)
      this.emit('message', payload)
      const title = payload.data.title
      let tag = null
      if (payload.data?.tag) {
        tag = payload.data.tag
      }
      let options = {
        body: payload.data.body,
        icon: payload.data.icon,
        image: payload.data.image,
        action: payload.data.link,
        badge: Meteor.absoluteUrl('images/logo/badge96.png'),
        renotify: !!tag
      }
      if (tag) {
        options.tag = tag
      }
      if (payload.data) {
        options.data = payload.data
      }

      if (tag) {
        notifications = await this.messaging.swRegistration.getNotifications({tag})
        if (notifications.length > 0) {
          options.body = notifications[0].body + '\n' +  options.body
        }
      }

      this.console.log('document.hidden', document.hidden)
      if (!document.hidden) {
        this.messaging.swRegistration.showNotification(title, options)
      }
    })

    // onTokenRefresh(this.messaging, async () => {
    //   // Delete the old Push from MongoDB and from the localStore
    //   this.unsubscribe()
    //   await this._getToken()
    // })

    this.on('token', token => {
      const data = {
        type: 'web',
        token,
        appName: this.configuration.appName,
      }
      Meteor.call(UPDATE_METHOD_NAME, data, (error, result) => {
        if (error) {
          return this.console.error('Could not save this token to DB: ', error)
        }
        this._setStorage({
          token
        })
      })
    })

    // Start listening for user updates Meteor.userId()
    this._firstRun = true
    Tracker.autorun(() => {
      Meteor.userId()
      const {token} = this._getStorage()

      // TODO check on this logic. This is for when a user logs in on a station after another user. Each user needs to set its own
      // Perhaps compare this with deviceStorage.getItem('WebPush-Subscribed', true)
      // Push context on that machine while the Token of the machine remains the same.
      // Eventually cater to a situation where a user receives certain Notifications, logs out and then receives only "general" notifications.
      if (!this._firstRun) {
        this.console.log('If I see this once, this is the first run.')
        
        const data = {
          type: 'web',
          token,
          appName: this.configuration.appName,
        }
        Meteor.call(UPDATE_METHOD_NAME, data, (error, result) => {
          if (error) {
            return this.console.error('Could not save this token to DB: ', error)
          }
          this._setStorage({
            token
          })
        })
      }
      this._firstRun = false
    })
  }

  async subscribe() {
    if (!this._isPushSupported || !this.configured) {
      return
    }

    // If the user did not block notifications, request for a token.
    // this.console.log(Notification.permission)
    try {
      const permissionResult = await Notification.requestPermission()
      if (permissionResult === 'denied') {
        deviceStorage.setItem('lastSubscriptionMessage', 'Permission wasn\'t granted. Allow a retry.')
        return
      }
      if (permissionResult === 'default') {
        deviceStorage.setItem('lastSubscriptionMessage', 'The permission request was dismissed.')
        return
      }
    } catch (e) {
      this.console.log('Error on subscription: ', e)
      this.console.log('WebPush error when asking for permission', interpretError(e))
      return
    }

    try {
      const token = await getToken(this.messaging, {vapidKey: this.configuration.publicVapidKey})
      if (token) {
        this.emit('token', token)
      } else {
        deviceStorage.setItem('lastSubscriptionMessage', 'No Instance ID token available. Request permission to generate one.')
      }
    } catch (e) {
      this.console.log('Error on getToken: ', e)
    }
  }

  async unsubscribe() {
    if (!this._isPushSupported || !this.configured) {
      return
    }

    const {token} = this._getStorage()

    if (!token || !this._isPushSupported) {
      return
    }

    try {
      const unsubscribeResult = await deleteToken(this.messaging)
    } catch (e) {
      this.console.log('Error unsubscribing: ', e)
    }

    const data = {
      type: 'web',
      token,
      appName: this.configuration.appName,
      unsubscribe: true
    }
    Meteor.call(UPDATE_METHOD_NAME, data, err => {
      if (err) {
        this.console.error('Could not save this token to DB: ', err)
      } else {
        this._setStorage({
          token: null
        })
      }
    })
  }

  showNotification(title, options) {
    if (!this._isPushSupported) {
      return Promise.resolve()
    }
    return this.messaging.swRegistration.showNotification(title, options)
  }

  async getNotifications(options) {
    if (!this._isPushSupported || !!!this.messaging.swRegistration) {
      return Promise.resolve([])
    }
    return await this.messaging.swRegistration.getNotifications(options)
  }

  /*
  *  Private methods
  */

  async _getToken() {
    let token
    try {
      token = await this.messaging.getToken({vapidKey: this.configuration.publicVapidKey})
    } catch (e) {
      this.console.log('Error on getToken: ', e)
    }

    if (token) {
      this.emit('token', token)
    } else {
      deviceStorage.setItem('lastSubscriptionMessage', 'No Instance ID token available. Request permission to generate one.')
    }
  }

  _setConsole(isDebug) {
    self = this
    if (isDebug) {
      this.console = {
        log: console.log.bind(console, `${PACKAGE_NAME}:`),
        error: console.error.bind(console, `${PACKAGE_NAME}:`)
      }
    } else {
      this.console = {
        log: noop,
        error: noop
      }
    }
  }

  _listenServiceWorkerControllerChange() {
    // Refresh all tabs after a service worker update takes place
    let refreshing
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) { return }
      refreshing = true
      window.location.reload()
    })
  }

  _setStorage(options) {
    const {appName} = this.configuration
    Object.assign(this._storage, options)
    deviceStorage.setItem(`${PACKAGE_NAME}.${appName}`, JSON.stringify(this._storage))
  }

  _getStorage() {
    const {appName} = this.configuration
    let storage
    try {
      storage = JSON.parse(deviceStorage.getItem(`${PACKAGE_NAME}.${appName}`))
    }
    catch(e) {
      this.console.error('Error while loading storage', e)
    }
    return storage || {}
  }
}

export const Push = new WebPush()
