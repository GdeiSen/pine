import http from 'k6/http'
import { check, sleep } from 'k6'
import { Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost'
const STATION_CODE = __ENV.STATION_CODE || ''
const ACCESS_TOKEN = __ENV.ACCESS_TOKEN || ''
const SCENARIO = __ENV.SCENARIO || 'steady'

const stationLatency = new Trend('pine_station_snapshot_latency_ms')
const manifestLatency = new Trend('pine_manifest_latency_ms')

const stagePresets = {
  smoke: [
    { duration: '30s', target: 5 },
    { duration: '30s', target: 0 },
  ],
  steady: [
    { duration: '1m', target: 25 },
    { duration: '3m', target: 25 },
    { duration: '1m', target: 0 },
  ],
  burst: [
    { duration: '30s', target: 100 },
    { duration: '2m', target: 100 },
    { duration: '30s', target: 0 },
  ],
}

const qualityPool = ['AUTO', 'LOW', 'MEDIUM', 'HIGH', 'ORIGINAL']

export const options = {
  stages: stagePresets[SCENARIO] || stagePresets.steady,
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<1200'],
    pine_station_snapshot_latency_ms: ['p(95)<600'],
    pine_manifest_latency_ms: ['p(95)<700'],
  },
}

function buildHeaders() {
  const headers = { Accept: 'application/json' }
  if (ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${ACCESS_TOKEN}`
  }
  return { headers }
}

function randomQuality() {
  return qualityPool[Math.floor(Math.random() * qualityPool.length)]
}

export default function () {
  if (!STATION_CODE) {
    throw new Error('STATION_CODE is required')
  }

  const stationRes = http.get(
    `${BASE_URL}/api/stations/${STATION_CODE}`,
    buildHeaders(),
  )
  stationLatency.add(stationRes.timings.duration)

  check(stationRes, {
    'station snapshot status is 200': (r) => r.status === 200,
  })
  if (stationRes.status !== 200) {
    sleep(1)
    return
  }

  const snapshot = stationRes.json()
  const trackId = snapshot?.currentTrack?.id
  if (typeof trackId === 'string' && trackId.length > 0) {
    const quality = randomQuality()
    const manifestRes = http.get(
      `${BASE_URL}/api/tracks/${trackId}/manifest?quality=${quality}`,
      buildHeaders(),
    )
    manifestLatency.add(manifestRes.timings.duration)

    check(manifestRes, {
      'manifest status is 200': (r) => r.status === 200,
      'manifest has stream url': (r) => {
        if (r.status !== 200) return false
        const body = r.json()
        return typeof body?.streamUrl === 'string' && body.streamUrl.length > 0
      },
    })
  }

  sleep(1)
}
