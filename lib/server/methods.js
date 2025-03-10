/* globals Mongo, Random */

import { Match, check } from 'meteor/check'
import { Push } from './push'
import { Meteor } from 'meteor/meteor'
import {Accounts} from 'meteor/accounts-base'
import {
  SET_USER_METHOD_NAME,
  UPDATE_METHOD_NAME,
  ANONYMOUS_TOPIC,
  AUTHENTICATED_TOPIC,
  DefaultTopics,
  PACKAGE_NAME
} from '../constants'

Push.appCollection = new Mongo.Collection('_push_app_tokens')
Push.appCollection.createIndex({ userId: 1 })

const matchToken = Match.OneOf({ web: String }, { android: String }, { apn: String }, { ios: String })

Meteor.methods({
  [UPDATE_METHOD_NAME]: async function(options) {
    if (Push.debug) {
      console.log(UPDATE_METHOD_NAME, options)
    }
    try {
      check(options, {
        appName: String,
        type: String,
        token: String,
        unsubscribe: Match.Optional(Match.OneOf(Boolean, null, undefined))
      })
    } catch (e) {
      return
    }
    
    const {appName, type, token, unsubscribe} = options

    let appToken = await Push.appCollection.findOneAsync({
      appName,
      token
    })

    if (unsubscribe) {
      if (appToken) {
        // Remove faceless token
        await Push.appCollection.removeAsync({_id: appToken._id})
        // Push.unsubscribeFromTopic(token, DefaultTopics.Anonymous)
        Push._callHook('onRemoveAnonymous', {token})
      }

      if (this.userId) {
        const currentUser = await Meteor.users.findOneAsync(this.userId)
        let isTokenFound = false
        const loginTokens = currentUser.services.resume.loginTokens.map((loginToken) => {
          if (loginToken.push?.token === token) {
            isTokenFound = true
            const {push, ...restLoginToken} = loginToken
            return restLoginToken
          } else { 
            return loginToken
          }
        })
        if (isTokenFound) {
          await Meteor.users.updateAsync({_id: this.userId}, {
            $set: {
              'services.resume.loginTokens': loginTokens
            }
          })
          // Push.unsubscribeFromTopic(token, DefaultTopics.Authenticated)
          Push._callHook('onRemoveAuthenticated', {token, userId: this.userId})
        }
      }

      return
    }

    if (this.userId) {
      const currentUser = await Meteor.users.findOneAsync(this.userId)
      if (appToken) {
        // Remove faceless token
        await Push.appCollection.removeAsync({_id: appToken._id})
        // Push.unsubscribeFromTopic(token, DefaultTopics.Anonymous)
        Push._callHook('onRemoveAnonymous', {token})
      }
      // Stop processing if token already exists
      const loginToken = currentUser.services.resume.loginTokens.find((loginToken) => {
        loginToken.push?.token === token
      })
      if (loginToken) {
        return
      }
      
      // Get current user's login token
      const hashedLoginToken = Accounts._accountData[this.connection.id].loginToken
      // Add push token to user's current resume token
      const loginTokens = currentUser.services.resume.loginTokens.map((loginToken) => {
        if (loginToken.hashedToken === hashedLoginToken) {
          return {
            ...loginToken,
            push: {
              appName,
              type,
              token
            }
          }
        } else { 
          return loginToken
        }
      })
      await Meteor.users.updateAsync({_id: this.userId}, {
        $set: {
          'services.resume.loginTokens': loginTokens
        }
      })
      // Here we need to subscribe token to topics
      // call handler to get app custom topics
      // Push.subscribeToTopic(token, DefaultTopics.Authenticated)
      Push._callHook('onAddAuthenticated', {token, userId: this.userId})
    } else if (!this.userId && appToken) {
      await Push.appCollection.updateAsync({_id: appToken._id}, {
        $set: {
          updatedAt: new Date()
        }
      })
    } else if (!this.userId && !appToken) {
      await Push.appCollection.insertAsync({
        appName,
        type,
        token,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      // Push.subscribeToTopic(token, DefaultTopics.Anonymous)
      Push._callHook('onAddAnonymous', {token})
    }
  },
  'push-unsub-webpush': async function (pushTokenId) {
    check(pushTokenId, String)
    return await Push.appCollection.removeAsync({ _id: pushTokenId })
  }
})
