export class CbmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CbmError';
  }
}
