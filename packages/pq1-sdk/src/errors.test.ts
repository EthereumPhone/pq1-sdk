// Every error the SDK throws carries a plain-language message for the user
// and keeps its technical detail for the logs.

import { BundlerError } from './aa/bundler'
import {
  getUserMessage,
  isPq1Error,
  Pq1Error,
  PQ1_ERROR_MESSAGES,
  toPq1Error,
  type Pq1ErrorCode
} from './errors'
import { DeviceError } from './transport/hid'

describe('Pq1Error', () => {
  it('keeps technical text in `message` and plain text in `userMessage`', () => {
    const e = new Pq1Error('locked', 'SW=0x6985 after GET_STATUS probe')
    expect(e.message).toBe('SW=0x6985 after GET_STATUS probe')
    expect(e.userMessage).toBe(PQ1_ERROR_MESSAGES.locked)
    expect(getUserMessage(e)).toBe(PQ1_ERROR_MESSAGES.locked)
  })

  it('never shows the user the text of an unexpected error', () => {
    expect(getUserMessage(new TypeError('x is undefined'))).toBe(PQ1_ERROR_MESSAGES.unknown)
    const wrapped = toPq1Error(new TypeError('x is undefined'))
    expect(wrapped.code).toBe('unknown')
    expect(wrapped.message).toBe('x is undefined')
    expect(wrapped.cause).toBeInstanceOf(TypeError)
  })

  it('recognises device and bundler errors as Pq1Errors', () => {
    const device = new DeviceError('HID read timeout', undefined, 'timeout')
    expect(device).toBeInstanceOf(Pq1Error)
    expect(device.code).toBe('timeout')
    expect(new DeviceError('bad reply').code).toBe('device-protocol')
    expect(isPq1Error(new BundlerError(-32500, 'AA25 invalid account nonce'))).toBe(true)
    expect(new BundlerError(-32500, 'AA25 invalid account nonce').userMessage).toContain(
      'still being processed'
    )
  })

  it('recognises a Pq1Error from another copy of the SDK', () => {
    expect(isPq1Error({ code: 'rejected', userMessage: 'x', message: 'y' })).toBe(true)
    expect(isPq1Error({ code: 'not-a-code', userMessage: 'x' })).toBe(false)
  })

  it('has a message without jargon for every code', () => {
    for (const [code, text] of Object.entries(PQ1_ERROR_MESSAGES) as [Pq1ErrorCode, string][]) {
      expect(text.length, code).toBeGreaterThan(20)
      expect(text, code).not.toMatch(/\b(SW|APDU|UserOp|ERC-?\d+|0x[0-9a-f]+)\b/i)
    }
  })
})
