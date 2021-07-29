import { Meteor } from 'meteor/meteor'
import EventEmitter from 'events'
import firebase from 'firebase-admin'

class PushServer extends EventEmitter {
  constructor() {
    super()
    this._configuration = {}
    this._configured = false
  }

  Configure(configuration) {
    this._configuration = configuration

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
      databaseURL: this._configuration.firebaseAdmin && this._configuration.firebaseAdmin.databaseURL
    })
    this._messaging = this._firebaseApp.messaging() // FCM with Firebase Admin
    if (this._configuration.firebaseAdmin) {
      if (this._configuration.debug) {
        console.log('Firebase Admin for Android Messaging configured')
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

    let tokens = []
    if (notification.userId) {
      const user = Meteor.users.findOne(notification.userId)
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
      Meteor.users.find({_id: {$in: notification.userIds}}).forEach((user) => {
        const userTokens = this._getUserTokens(user)
        _tokens = [..._tokens, userTokens]
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
    
    // if (tokens) {
    //   if (!Array.isArray(tokens)) {
    //     message.token = tokens
    //   } else {
    //     message.tokens = tokens
    //   }
    // } else if (message.topic) {
    //   message.topic = notification.topic
    // } else {
    //   if (this._configuration.debug) {
    //     console.warn('Missing scope, no token or topic to send to')
    //   }
    //   return
    // }

    if (this._configuration.debug) {
      console.log('Final notification right before shoot out:', JSON.stringify(message, null, 2))
    }

    let response
    try {
      if (message.tokens) {
        response = await this._messaging.sendMulticast(message)
      } else if (message.token || message.topic) {
        response = await this._messaging.send(message)
      }
      if (this._configuration.debug) {
        console.log('Successfully sent message:', response)
      }
    } catch (e) {
      if (this._configuration.debug) {
        console.log('FCM Sending Error: ', JSON.stringify(e, null, 2))
      }
    }
    return response
  }

  async _send(tokens, notification) {
    let message = this._getMessage(notification)

    if (tokens) {
      if (!Array.isArray(tokens)) {
        message.token = tokens
      } else {
        message.tokens = tokens
      }
    } else if (message.topic) {
      message.topic = notification.topic
    } else {
      if (this._configuration.debug) {
        console.warn('Missing scope, no token or topic to send to')
      }
      return
    }

    if (this._configuration.debug) {
      console.log('Final notification right before shoot out:', JSON.stringify(message, null, 2))
    }

    let response
    try {
      if (message.tokens?.length > 0) {
        response = await this._messaging.sendMulticast(message)
      } else {
        response = await this._messaging.send(message)
      }
      if (this._configuration.debug) {
        console.log('Successfully sent message:', response)
      }
    } catch (e) {
      if (this._configuration.debug) {
        console.error('FCM Sending Error: ', JSON.stringify(e, null, 2))
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

  _getUserTokens(user) {
    return user.services.resume.loginTokens
    .filter((loginToken) => !!loginToken.push?.token)
    .map((loginToken) => loginToken.push?.token)
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
          title: notification.title,
          body: notification.body,
          icon: notification.icon || defaults.icon,
          color: notification.color || defaults.color,
          sound: notification.sound || defaults.sound,
          // tag: `${notification.notId}`,
          // click_action: notification.action
          channel_id: notification.channelId || defaults.channelId || defaults.topic,
          notification_priority: notification.notificationPriority || defaults.notificationPriority,
          visibility: notification.visibility || defaults.visibility,
          // notification_count: notification.badge || defaults.badge, // this is supposed to be a number, can't send it because I need it to be a string.
          // image: notification.imageUrl || defaults.imageUrl || undefined,
          ...globalData,
          ...noteAndroidData
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
          ...noteWebData
        },
        notification: {
          title: notification.title,
          body: notification.body,
          icon: notification.webIcon || defaults.webIcon,
          // image: notification.imageUrl || defaults.imageUrl
          /*
          actions: [
            {
              action: notification.action || defaults.action,
              title: 'Book Appointment'
            }
          ] */
        }, // Can take valued from here: https://developer.mozilla.org/en-US/docs/Web/API/Notification.
        fcm_options: {
          link: notification.action || defaults.action
        }
      }
    }
 
    if (image) {
      message.android.data.image = image
      message.apns.fcm_options.image = image
      message.webpush.notification.image = image
    }

    return message
  }
}

export const Push = new PushServer()