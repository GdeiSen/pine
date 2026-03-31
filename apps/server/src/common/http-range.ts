export type ByteRangeResult =
  | { kind: 'none' }
  | { kind: 'partial'; start: number; end: number; length: number }
  | { kind: 'unsatisfiable' }

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return parsed
}

export function parseSingleByteRange(rangeHeader: string | undefined, totalSize: number): ByteRangeResult {
  if (!rangeHeader || totalSize <= 0) return { kind: 'none' }

  const trimmed = rangeHeader.trim()
  if (!trimmed.toLowerCase().startsWith('bytes=')) return { kind: 'none' }

  // We intentionally support only a single byte range.
  const rangeSpec = trimmed.slice('bytes='.length).split(',')[0]?.trim()
  if (!rangeSpec) return { kind: 'none' }

  const [rawStart, rawEnd] = rangeSpec.split('-')
  if (rawStart === undefined || rawEnd === undefined) return { kind: 'none' }

  if (rawStart.length === 0 && rawEnd.length === 0) return { kind: 'none' }

  if (rawStart.length > 0 && rawEnd.length > 0) {
    const start = parseNonNegativeInteger(rawStart)
    const requestedEnd = parseNonNegativeInteger(rawEnd)
    if (start === null || requestedEnd === null) return { kind: 'none' }
    if (start >= totalSize || requestedEnd < start) return { kind: 'unsatisfiable' }

    const end = Math.min(requestedEnd, totalSize - 1)
    return { kind: 'partial', start, end, length: end - start + 1 }
  }

  if (rawStart.length > 0) {
    const start = parseNonNegativeInteger(rawStart)
    if (start === null || start >= totalSize) return { kind: 'unsatisfiable' }

    const end = totalSize - 1
    return { kind: 'partial', start, end, length: end - start + 1 }
  }

  const suffixLength = parseNonNegativeInteger(rawEnd)
  if (suffixLength === null || suffixLength <= 0) return { kind: 'unsatisfiable' }

  const length = Math.min(suffixLength, totalSize)
  const start = totalSize - length
  const end = totalSize - 1
  return { kind: 'partial', start, end, length }
}
