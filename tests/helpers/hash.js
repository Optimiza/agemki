/**
 * @fileoverview Helpers de hashing para los tests de golden files.
 *
 * Wrappers ergonómicos sobre `node:crypto` para SHA-256 y formato hex.
 * Aislados aquí para que los tests no dependan de la API exacta de node.
 */
import { createHash } from 'node:crypto'

/** @param {Buffer|Uint8Array|string} data @returns {string} SHA-256 en hex */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @param {Buffer|Uint8Array} buf @returns {string} primeros N bytes en hex */
export function hexHead(buf, n = 16) {
  const slice = Buffer.from(buf).subarray(0, n)
  return slice.toString('hex').toUpperCase()
}
