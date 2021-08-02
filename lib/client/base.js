import EventEmitter from 'events'

export default class BasePush extends EventEmitter {
  constructor() {
    super()
    this._config = {}
    this._configured = false
  }

  config(config) {}
}