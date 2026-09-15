/* globals Mongo, Random */

import { Match, check } from 'meteor/check'
import { Push, unsetPushToken } from './push'
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
        // Стабильный ключ приложения ('admin'|'cabinet'|'spaces'); у клиентов, выкаченных до
        // его появления, поля нет — Optional, а не String.
        app: Match.Optional(String),
        type: String,
        token: String,
        unsubscribe: Match.Optional(Match.OneOf(Boolean, null, undefined))
      })
    } catch (e) {
      return
    }

    const {appName, app, type, token, unsubscribe} = options

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
        const removed = await unsetPushToken(this.userId, token)
        if (removed) {
          // Push.unsubscribeFromTopic(token, DefaultTopics.Authenticated)
          Push._callHook('onRemoveAuthenticated', {token, userId: this.userId})
        }
      }

      return
    }

    if (this.userId) {
      if (appToken) {
        // Remove faceless token
        await Push.appCollection.removeAsync({_id: appToken._id})
        // Push.unsubscribeFromTopic(token, DefaultTopics.Anonymous)
        Push._callHook('onRemoveAnonymous', {token})
      }
      const hashedLoginToken = Accounts._getLoginToken(this.connection.id)
      if (!hashedLoginToken) return

      const currentUser = await Meteor.users.findOneAsync(this.userId, {fields: {'services.resume.loginTokens': 1}})
      const loginTokens = currentUser?.services?.resume?.loginTokens || []
      // Тот же токен уже на этой сессии — повтор регистрации, писать нечего. (Раньше find со
      // скобками всегда давал undefined, и весь массив переписывался на каждый вызов.)
      const current = loginTokens.find((loginToken) => loginToken.hashedToken === hashedLoginToken)
      if (current?.push?.token === token) return

      // Токен принадлежит устройству: с прежних сессий этого юзера снимаем, иначе пуш уйдёт дважды.
      if (loginTokens.some((loginToken) => loginToken.push?.token === token)) {
        await unsetPushToken(this.userId, token)
      }
      // Позиционный $ по hashedToken: не затираем client/authMethod этой и соседних сессий.
      await Meteor.users.updateAsync(
        {_id: this.userId, 'services.resume.loginTokens.hashedToken': hashedLoginToken},
        {$set: {'services.resume.loginTokens.$.push': {
          appName,
          type,
          token,
          // Стабильный ключ приложения; у старых клиентов его нет — ключ не пишем вовсе.
          ...(app ? {app} : {})
        }}}
      )
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
        ...(app ? {app} : {}),
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
