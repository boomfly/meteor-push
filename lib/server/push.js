import { Meteor } from 'meteor/meteor'
import EventEmitter from 'events'
import firebase from 'firebase-admin'

class PushServer extends EventEmitter {
  constructor() {
    super()
    this._configuration = {
      debug: false
    }
    this._configured = false
    this._hooks = {}
  }

  Configure(configuration) {
    this._configuration = Object.assign(this._configuration, configuration)

    if (this._configured) {
      throw new Error('Push.Configure should not be called more than once!')
    
    }
    this._configured = true
    
    if (this._configuration.debug) {
      console.log('Push.Configure', this._configuration)
    }

    // Rig FCM connection
    this._firebaseApp = firebase.initializeApp({
      credential: firebase.credential.cert(
        this._configuration.firebaseAdmin && this._configuration.firebaseAdmin.serviceAccountData
      ),
      // databaseURL: this._configuration.firebaseAdmin && this._configuration.firebaseAdmin.databaseURL
    })
    this._messaging = this._firebaseApp.messaging() // FCM with Firebase Admin
    if (this._configuration.firebaseAdmin) {
      if (this._configuration.debug) {
        console.log('Firebase Admin for FCM configured')
      }
      if (!this._configuration.firebaseAdmin.serviceAccountData) {
        console.error('ERROR: Push server could not find Android serviceAccountData information')
      }
      if (!this._configuration.firebaseAdmin.databaseURL) {
        console.error('ERROR: Push server could not find databaseURL information')
      }
    }
  }

  async send(notification) {
    let message = this._getMessage(notification)

    if (notification.token) {
      message.token = notification.token
    } else if (notification.tokens) {
      message.tokens = notification.tokens
    } else if (notification.userId) {
      const user = await Meteor.users.findOneAsync(notification.userId)
      if (!user) {
        if (this._configuration.debug) {
          console.warn('User not found to send push userId:', notification.userId)
        }
        return
      }

      const userTokens = this._getUserTokens(user)
      if (userTokens.length === 0) {
        if (this._configuration.debug) {
          console.warn('User does not have push tokens userId:', notification.userId)
        }
        return
      }
      if (userTokens.length > 1) {
        message.tokens = userTokens
      } else {
        message.token = userTokens[0]
      }
    } else if (notification.userIds) {
      _tokens = []
      await Meteor.users.find({_id: {$in: notification.userIds}}).forEachAsync((user) => {
        const userTokens = this._getUserTokens(user)
        _tokens = [..._tokens, ...userTokens]
      })
      if (_tokens.length === 0) {
        if (this._configuration.debug) {
          console.warn('Users does not have push tokens userIds:', notification.userIds)
        }
        return
      }
      message.tokens = _tokens
    } else if (notification.topic) {
      message.topic = notification.topic
    } else {
      if (this._configuration.debug) {
        console.error('Missing scope, no token or topic to send to')
      }
    }

    if (this._configuration.debug) {
      console.log('Final notification right before shoot out:', JSON.stringify(message, null, 2))
    }

    message = JSON.parse(JSON.stringify(message))

    let response
    try {
      if (message.tokens) {
        response = await this._messaging.sendEachForMulticast(message)
        if (response.failureCount > 0) {
          this._processFailedResponse(response, message.tokens)
        }
      } else if (message.token || message.topic) {
        response = await this._messaging.send(message)
        if (response.failureCount > 0) {
          this._processFailedResponse(response, [message.token])
        }
      }
      if (this._configuration.debug) {
        console.log('Successfully sent message:', JSON.stringify(response, null, 2))
      }
    } catch (e) {
      if (this._configuration.debug) {
        console.log('FCM Sending Error: ', JSON.stringify(e, null, 2))
      }
    }
    return response
  }

  async subscribeToTopic(tokens, topics) {
    if (!Array.isArray(tokens)) {
      tokens = [tokens]
    }
    if (!Array.isArray(topics)) {
      topics = [topics]
    }
    return Promise.all(
      topics.map((topic) => this._messaging.subscribeToTopic(tokens, topic))
    )
  }

  async unsubscribeFromTopic(tokens, topics) {
    if (!Array.isArray(tokens)) {
      tokens = [tokens]
    }
    if (!Array.isArray(topics)) {
      topics = [topics]
    }
    return Promise.all(
      topics.map((topic) => this._messaging.unsubscribeFromTopic(tokens, topic))
    )
  }

  setHook(name, cb) {
    this._hooks[name] = cb
  }

  _processFailedResponse(res, tokens) {
    res.responses.forEach((response, index) => {
      if (response.success) {
        return
      }

      switch (response.error.code) {
        case 'messaging/registration-token-not-registered':
          this._removeToken(tokens[index])
          break
      }
    })
  }

  async _removeToken(token) {
    await Push.appCollection.removeAsync({token})
    const users = await Meteor.users.find({
      'services.resume.loginTokens.push.token': token
    }).fetchAsync()
    
    for (let user of users) {
      const loginTokens = user.services.resume.loginTokens.map((loginToken) => {
        if (loginToken.push?.token !== token) {
          return loginToken
        }
        const {push, ...restLoginToken} = loginToken
        return {
          ...restLoginToken
        }
      })
      await Meteor.users.updateAsync({_id: user._id}, {
        $set: {
          'services.resume.loginTokens': loginTokens
        }
      })
    }
  }

  _getUserTokens(user) {
    return (user.services?.resume?.loginTokens || [])
    .filter((loginToken) => !!loginToken.push?.token)
    .map((loginToken) => loginToken.push.token)
    .filter((token, index, self) => self.indexOf(token) === index)
  }

  _getMessage(notification) {
    // https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
    /**
     * For Android, the entire notification goes into 'data' as per the best practices of cordova-push-plugin
     * All commented fields are part of the Firebase-Admin but are not necessary for the present setup. For example, all keys of the
     * 'data' object must be strings while in Firebase-Admin some keys which would normally go under 'notification', are boolean.
     * I keep the commented fields just as quick reference for the standard.
     */
    const {defaults} = this._configuration
    const noteAndroidData = notification.androidData || {}
    const noteIosData = notification.iosData || {}
    const noteWebData = notification.webData || {}
    const globalData = notification.data || {}

    const image = notification.imageUrl || defaults.imageUrl

    const message = {
      android: {
        // ttl: '86400s', // use default max of 4 weeks
        // collapse_key: string,
        priority: defaults.priority,
        // restricted_package_name: string,
        data: {
          ...globalData,
          ...noteAndroidData,
          title: notification.title,
          body: notification.body,
          icon: notification.icon || defaults.icon,
          color: notification.color || defaults.color,
          sound: notification.sound || defaults.sound || 'default',
          click_action: notification.action || undefined,
          tag: notification.tag || globalData.tag || undefined,
          channelId: notification.channelId || defaults.channelId || undefined,
          priority: notification.priority || defaults.priority || undefined,
          visibility: notification.visibility || defaults.visibility || undefined,
          // notification_count: notification.badge || defaults.badge, // this is supposed to be a number, can't send it because I need it to be a string.
          'image-type': notification.imageType || undefined,
          image: notification.image || defaults.image || undefined,
          picture: notification.picture || defaults.picture || undefined,
          summaryText: notification.summaryText || undefined,
          style: notification.style || undefined
        },
        fcm_options: {
          analytics_label: notification.analyticsLabel || defaults.analyticsLabel
        }
      },
      apns: {
        headers: {
          'apns-priority': defaults.apnsPriority
        },
        payload: {
          aps: {
            alert: {
              title: notification.title,
              body: notification.body,
              'launch-image': notification.launchImage || defaults.launchImage
            },
            badge: notification.badge || defaults.badge,
            sound: notification.sound ? `${notification.sound}.caf` : defaults.sound ? `${defaults.sound}.caf` : '',
            // 'click-action' // TODO check on this,
            data: {
              ...defaults.data,
              ...defaults.iosData,
              ...globalData,
              ...noteIosData
            }
          }
        },
        fcm_options: {
          analytics_label: notification.analyticsLabel || defaults.analyticsLabel,
          // image: notification.imageUrl || defaults.imageUrl
        }
      },
      webpush: {
        headers: {
          Urgency: 'high',
          TTL: defaults.webTTL // mandatory, in seconds
        },
        data: {
          ...defaults.data,
          ...defaults.webData,
          ...globalData,
          ...noteWebData,
          badge: notification.webBadge || defaults.webBadge,
          title: notification.title,
          body: notification.body,
          icon: notification.image || defaults.image,
          image: notification.picture || undefined,
          link: notification.action || defaults.action
        },
        // notification: {
        //   title: notification.title,
        //   body: notification.body,
        //   icon: notification.image || defaults.image,
        //   image: notification.picture || undefined
        //   /*
        //   actions: [
        //     {
        //       action: notification.action || defaults.action,
        //       title: 'Book Appointment'
        //     }
        //   ] */
        // }, // Can take valued from here: https://developer.mozilla.org/en-US/docs/Web/API/Notification.
        fcm_options: {
          link: notification.action || defaults.action
        }
      }
    }
 
    // if (image) {
    //   message.android.data.image = image
    //   message.apns.fcm_options.image = image
    //   message.webpush.notification.image = image
    // }

    return message
  }

  _callHook(name, params) {
    const cb = this._hooks[name]
    if (typeof cb === 'function') {
      cb(params)
    }
  }
}

export const Push = new PushServer()