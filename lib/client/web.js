/* globals Notification, ServiceWorkerRegistration, PushSubscription */
// Firebase (firebase/app + firebase/messaging, ~290 KB) is not imported statically: it would ship in
// this package's file to every visitor. _initFirebase() pulls it in with import() when push is
// actually used — see WebPush.config().
import {
  PACKAGE_NAME,
  UPDATE_METHOD_NAME
} from '../constants'
import BasePush from './base'

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

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

// Synchronous twin of firebase/messaging isSupported() (@firebase/messaging isWindowSupported): the
// same API checks without loading Firebase. Its async probe that opens a throwaway IndexedDB
// (fails in Firefox private mode, Safari iframes) is left to firebase's own isSupported() in
// _loadFirebase(). A secure context is implied: serviceWorker and PushManager exist only there.
const isBrowserSupported = () => {
  try {
    return typeof window !== 'undefined' &&
      typeof indexedDB === 'object' &&
      !!navigator.cookieEnabled &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window &&
      'fetch' in window &&
      hasOwn(ServiceWorkerRegistration.prototype, 'showNotification') &&
      hasOwn(PushSubscription.prototype, 'getKey')
  } catch (e) {
    return false
  }
}

class WebPush extends BasePush {
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

  // config() does only cheap checks; Firebase is loaded by _initFirebase(): right here when
  // notifications are already granted (a subscribed user needs the foreground listener and a live
  // token), otherwise on the first subscribe()/unsubscribe(). subscribe()/unsubscribe() wait for
  // the first config(): callers invoke them right after it without awaiting.
  config(configuration = {}) {
    const configured = this._configure(configuration)
    this._configPromise = this._configPromise || configured
    return configured
  }

  // Can this browser receive web push with the given config? Resolves after config(); does not
  // load Firebase. false before config().
  async isSupported() {
    await this._configPromise?.catch(noop)
    return this._canPush()
  }

  // Legacy contract of the hosts: `await Push._ready`, then `!!Push.messaging` means "push works
  // here". To keep it with lazy Firebase, awaiting _ready loads Firebase (if the browser can push at
  // all). New code should call isSupported(), which does not.
  get _ready() {
    return this._configPromise && this._configPromise.then(() => this._initFirebase())
  }

  async _configure(configuration) {
    this._setConsole(configuration.debug)

    if (this.configured) {
      this.console.error('Push.Error: "Push.Configure may only be called once"')
      throw new Error('Push.Configure may only be called once')
    }

    this.configuration = configuration
    this._storage = this._getStorage()

    this.console.log('WebPushHandle.Configure:', configuration)
    this.configured = true

    this._isPushSupported = isBrowserSupported()
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
      this._setTokenState('unsupported', 'ServiceWorker not supported')
      return
    }

    if (this._isFacebookApp) {
      this.console.error('FacebookApp not supported')
      this._setTokenState('unsupported', 'FacebookApp not supported')
      return
    }

    if (!this._isPushSupported) {
      this.console.error('Push not supported')
      this._setTokenState('unsupported', 'Push not supported')
      return
    }

    if (!this._hasConfig) {
      this.console.error('Firebase configuration is required: \'messagingSenderId\' and a \'PublicVapidKey\'')
      this._setTokenState('unsupported', 'Firebase configuration is required')
      return
    }

    this.on('token', token => this._saveToken(token))

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
        // Без сохранённого токена звать нечего: сервер отбросил бы вызов проверкой аргументов.
        if (token) {
          this._saveToken(token)
        }
      }
      this._firstRun = false
    })

    // Already subscribed: the foreground listener and the token need Firebase now.
    if (Notification.permission === 'granted') {
      this._initFirebase()
    }
  }

  async subscribe() {
    await this._configPromise?.catch(noop)
    if (!this._canPush()) {
      return
    }

    // Permission first, Firebase after: browsers honour requestPermission() only close to the
    // user's click, a chunk download in between could cost the prompt.
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

    await this._getToken()
  }

  async unsubscribe() {
    await this._configPromise?.catch(noop)
    const {token} = this._getStorage()

    if (!token) {
      return
    }

    const messaging = await this._initFirebase()
    if (!messaging) {
      return
    }

    try {
      await this._firebase.deleteToken(messaging)
    } catch (e) {
      this.console.log('Error unsubscribing: ', e)
    }

    const data = {
      type: 'web',
      token,
      appName: this.configuration.appName,
      app: this.configuration.app,
      unsubscribe: true
    }
    Meteor.call(UPDATE_METHOD_NAME, data, err => {
      if (err) {
        this.console.error('Could not save this token to DB: ', err)
      } else {
        this._setStorage({
          token: null
        })
        this._setTokenState(undefined)
      }
    })
  }

  // Neither loads Firebase: without it nothing was shown. They only wait for a load in flight —
  // config() starts one at page start when notifications are granted.
  async showNotification(title, options) {
    const messaging = await this._firebaseReady
    if (!messaging?.swRegistration) {
      return
    }
    return messaging.swRegistration.showNotification(title, options)
  }

  async getNotifications(options) {
    const messaging = await this._firebaseReady
    if (!messaging?.swRegistration) {
      return []
    }
    return await messaging.swRegistration.getNotifications(options)
  }

  /*
  *  Private methods
  */

  // Регистрация токена на сервере. pending — пока ответа нет: на обрыве DDP держит вызов в
  // очереди, а перезагрузка страницы его теряет — тогда состояние так и останется pending.
  _saveToken(token) {
    const data = {
      type: 'web',
      token,
      appName: this.configuration.appName,
      app: this.configuration.app,
    }
    this._setTokenState('pending')
    Meteor.call(UPDATE_METHOD_NAME, data, (error) => {
      if (error) {
        this._setTokenState('failed', error.message || error)
        return this.console.error('Could not save this token to DB: ', error)
      }
      this._setStorage({
        token
      })
      this._setTokenState('saved')
    })
  }

  _canPush() {
    return !!(
      this.configured &&
      this._isServiceWorkerSupported &&
      !this._isFacebookApp &&
      this._isPushSupported &&
      this._hasConfig
    )
  }

  // Idempotent: resolves to the Messaging instance, or null where push can't work. A failed chunk
  // download is not cached — the next call retries it.
  _initFirebase() {
    if (!this._canPush()) {
      return Promise.resolve(null)
    }
    this._firebaseReady = this._firebaseReady || this._loadFirebase()
    return this._firebaseReady
  }

  async _loadFirebase() {
    let app, messaging
    try {
      [app, messaging] = await Promise.all([import('firebase/app'), import('firebase/messaging')])
    } catch (e) {
      this.console.error('Error loading Firebase: ', e)
      this._firebaseReady = null
      this._setTokenState('failed', e?.message || e)
      return null
    }

    // The IndexedDB probe the synchronous check skipped.
    if (!(await messaging.isSupported())) {
      this.console.error('Push not supported')
      this._isPushSupported = false
      this._setTokenState('unsupported', 'Push not supported')
      return null
    }

    try {
      this.messaging = messaging.getMessaging(app.initializeApp(this.configuration.firebase))
    } catch (e) {
      this.console.error('Error initializing Firebase messaging: ', e)
      this._setTokenState('unsupported', e?.message || e)
      return null
    }
    this._firebase = messaging

    // Refresh all tabs after a service worker update takes place
    this._listenServiceWorkerControllerChange()

    // Foreground messages; background ones are dealt with by the worker.
    messaging.onMessage(this.messaging, payload => this._onForegroundMessage(payload))

    return this.messaging
  }

  async _onForegroundMessage(payload) {
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
      badge: Meteor.absoluteUrl('brand/badge96.png'),
      renotify: !!tag
    }
    if (tag) {
      options.tag = tag
    }
    if (payload.data) {
      options.data = payload.data
    }

    if (tag) {
      const notifications = await this.messaging.swRegistration.getNotifications({tag})
      if (notifications.length > 0) {
        options.body = notifications[0].body + '\n' +  options.body
      }
    }

    this.console.log('document.hidden', document.hidden)
    if (!document.hidden) {
      this.messaging.swRegistration.showNotification(title, options)
    }
  }

  async _getToken() {
    const messaging = await this._initFirebase()
    if (!messaging) {
      return
    }

    let token
    try {
      token = await this._firebase.getToken(messaging, {vapidKey: this.configuration.publicVapidKey})
    } catch (e) {
      this.console.log('Error on getToken: ', e)
      this._setTokenState('failed', e?.message || e)
      return
    }

    if (token) {
      this.emit('token', token)
    } else {
      deviceStorage.setItem('lastSubscriptionMessage', 'No Instance ID token available. Request permission to generate one.')
      this._setTokenState('failed', 'No Instance ID token available')
    }
  }

  _setConsole(isDebug) {
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
