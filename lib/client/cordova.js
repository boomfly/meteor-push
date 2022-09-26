/* global device: false */
/* global PushNotification: false, EJSON, Package */

import { Meteor } from 'meteor/meteor'
import { Tracker } from 'meteor/tracker'
import EventEmitter from 'events'
import {
  PACKAGE_NAME,
  UPDATE_METHOD_NAME
} from '../constants'
import BasePush from './base'

const noop = function() {}

const deviceStorage = window.localStorage

class CordovaPush extends BasePush {
  constructor () {
    super()
    this._configured = false
    this._config = {}
  }

  config (config = {}) {
    this._setConsole(config.debug)

    if (this._configured) {
      this.console.error('Push.Error: "Push.Configure may only be called once"')
      throw new Error('Push.Configure may only be called once')
    }

    this.console.log('PushHandle.Configure:', config)
    this._configured = true
    this._storage = this._getStorage()
    this._config = config

    if (typeof PushNotification === 'undefined') {
      this.console.error('Push.Error: "Cordova PushNotification plugin required"')
      throw new Error('Cordova PushNotification plugin required')
    }

    this._push = PushNotification.init(this._config)
    /*
      PushNotification.hasPermission(data => {
        console.log('has permission? ', data)
      })
    */

    this._push.on('registration', data => {
      const {registrationId: token} = data
      const storage = this._getStorage()
      this.console.log('device registration has been triggered with this data:', data)
      if (token && storage.token && storage.token !== token) {
        this.console.log('PushHandle.Token changed:', token)
        // remove old token from db
        const data = {
          type: this._getType(),
          token: token,
          appName: this._config.appName,
          unsubscribe: true
        }
        Meteor.call(UPDATE_METHOD_NAME, data)
      }
      this.emit('token', token)
    })

    this._push.on('notification', data => {
      this.console.log('PushHandle.Notification:', data)
      if (data.additionalData.ejson) {
        if (data.additionalData.ejson === '' + data.additionalData.ejson) {
          try {
            data.payload = EJSON.parse(data.additionalData.ejson)
            this.console.log('PushHandle.Parsed.EJSON.Payload:', data.payload)
          } catch (err) {
            this.console.log('PushHandle.Parsed.EJSON.Payload.Error', err.message, data.payload)
          }
        } else {
          data.payload = EJSON.fromJSONValue(data.additionalData.ejson)
          this.console.log('PushHandle.EJSON.Payload:', data.payload)
        }
      }

      this.emit('message', data)

      // Emit alert event - this requires the app to be in foreground
      if (data.message && data.additionalData.foreground) {
        this.emit('alert', data)
      }

      // Emit sound event
      if (data.sound) {
        this.emit('sound', data)
      }

      // Emit badge event
      if (typeof data.count !== 'undefined') {
        this.console.log('PushHandle.SettingBadge:', data.count)
        this.setBadge(data.count)
        this.emit('badge', data)
      }

      // if (data.additionalData.foreground) {
      //   this.console.log('PushHandle.Message: Got message while app is open:', data)
      //   // TODO handle this
      //   this.emit('foreground', data)
      // } else {
      //   this.console.log('PushHandle.Startup: Got message while app was closed/in background:', data)
      //   this.emit('startup', data)
      // }
    })

    this._push.on('error', e => {
      this.console.log('PushHandle.Error:', e)
      this.emit('error', {
        type: this._getType() + '.cordova',
        error: e.message
      })
    })

    this.emit('ready')

    this.on('token', token => {
      this.console.log('Got token:', token)
      const data = {
        type: this._getType(),
        token,
        appName: this._config.appName,
      }
      Meteor.call(UPDATE_METHOD_NAME, data, (err, res) => {
        if (err) {
          this.console.log('Could not save this token to DB: ', err)
        } else {
          this.console.log('Let\'s see the result of update', res)
          this._setStorage({
            token
          })
        }
      })
    })

    this._firstRun = true
    Tracker.autorun(() => {
      Meteor.userId()
      const {token} = this._getStorage()
      
      if (!this._firstRun) {
        if (token) {
          const data = {
            type: this._getType(),
            token,
            appName: this._config.appName,
          }
          Meteor.call(UPDATE_METHOD_NAME, data) 
        }
      }
      this._firstRun = false
    })
  }

  async setBadge (count) {
    if (!/ios/i.test(device.platform)) {
      return Promise.resolve()
    }
    this.console.log('PushHandle.setBadge:', count)
    // xxx: at the moment only supported on iOS
    return await new Promise((resolve, reject) => {
      this._push.setApplicationIconBadgeNumber(() => {
        this.console.log('PushHandle.setBadge: was set to', count)
        resolve()
      }, (e) => {
        this.console.error('PushHandle.setBadge:', e)
        reject(e)
      }, count)
    })
  }

  async getBadge () {
    if (!/ios/i.test(device.platform)) {
      return Promise.resolve(0)
    }
    this.console.log('PushHandle.getBadge')
    // xxx: at the moment only supported on iOS
    return await new Promise((resolve, reject) => {
      this._push.getApplicationIconBadgeNumber((count) => {
        this.console.log('PushHandle.getBadge: ', count)
        resolve(count)
      }, (e) => {
        this.console.error('PushHandle.getBadge:', e)
        reject(e)
      })
    })
  }

  async clearAllNotifications () {
    this.console.log('clearAllNotifications')
    // xxx: at the moment only supported on iOS
    return await new Promise((resolve, reject) => {
      this._push.clearAllNotifications(() => {
        this.console.log('clearAllNotifications: success')
        resolve()
      }, (e) => {
        this.console.error('clearAllNotifications:', e)
        reject(e)
      })
    })
  }

  async unregister() {
    if (!this._push) {
      return this.console.error('unregister: Push not configured')
    }
    return await new Promise((resolve, reject) => {
      this._push.unregister(() => {
        this.console.log('unregister: success')
        resolve()
      }, (e) => {
        this.console.error('unregister:', e)
        reject(e)
      })
    })
  }

  /*
  *  Private methods
  */

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

  _getType() {
    if (/android/i.test(device.platform)) {
      return 'android'
    } else if (/ios/i.test(device.platform)) {
      return 'apn'
    }
    return 'unknown'
  }

  _setStorage(options) {
    const {appName} = this._config
    Object.assign(this._storage, options)
    deviceStorage.setItem(`${PACKAGE_NAME}.${appName}`, JSON.stringify(this._storage))
  }

  _getStorage() {
    const {appName} = this._config
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

export const Push = new CordovaPush()
