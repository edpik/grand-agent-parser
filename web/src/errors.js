export class ConversionError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'ConversionError'; }
}
