import EventEmitter from 'events'

export default class BasePush extends EventEmitter {
  constructor() {
    super()
    this._config = {}
    this._configured = false
  }

  config(config) {}

  // Состояние пуш-токена этой установки — то, что сессия показывает серверу
  // (apartx-shared/session → client.pushToken): unsupported — пуши в этой среде не поднять;
  // failed — упал getToken, плагин или запись на сервер; pending — токен есть, сервер запись ещё
  // не подтвердил; saved — записан. undefined — ничего ещё не происходило. Разрешение
  // (Notification.permission / hasPermission) сюда не входит — оно отдельно.
  tokenState() {
    return this._getStorage().tokenState
  }

  _setTokenState(status, error) {
    const tokenState = status ? {status, ...(error ? {error: String(error)} : {})} : undefined
    this._setStorage({tokenState})
    this.emit('tokenState', tokenState)
  }
}
