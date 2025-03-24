import { createSignal, createMemo, onCleanup, onMount } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { cancelUpload, getUploadQueue } from '~/api/athena'
import { getAthenaOfflineQueue } from '~/api/devices'
import type { UploadFilesToUrlsRequest, UploadItem } from '~/types'
import { UploadQueueItem as AthenaOnlineUploadQueueItem, AthenaOfflineQueueItem } from '~/types'

const parseUploadPath = (url: string) => {
  const parts = new URL(url).pathname.split('/')
  if (parts.length < 5) throw new Error('Unexpected upload path: ' + url)

  const route = parts[3]
  const segment = parseInt(parts[4], 10)
  const filename = parts[5]

  return { route, segment, filename }
}

const getUploadStatus = (item: AthenaOnlineUploadQueueItem | AthenaOfflineQueueItem<unknown>, progress: number): UploadItem['status'] => {
  if (!('current' in item)) return 'waiting_for_network'
  if (progress === 100) return 'completed'
  if (item.current) return 'uploading'
  if (item.retry_count > 0) return 'error'
  return 'queued'
}

const formatProgress = (item: AthenaOnlineUploadQueueItem | AthenaOfflineQueueItem<unknown>) =>
  'current' in item ? Math.round(item.progress * 100) : 0

const getStatusPriority = (status: UploadItem['status']): number =>
  status === 'uploading' ? 1 : status === 'completed' || status === 'error' ? 0 : 2

const mapOfflineQueue = (data: AthenaOfflineQueueItem<unknown>[]): UploadItem[] =>
  data
    .filter((item) => item.method === 'uploadFilesToUrls')
    .flatMap((item) =>
      (item as AthenaOfflineQueueItem<UploadFilesToUrlsRequest>).params.files_data.map((file) => {
        const { route, segment, filename } = parseUploadPath(file.url)
        const progress = formatProgress(item)
        return {
          id: file.url,
          route,
          segment,
          filename,
          uploadUrl: file.url,
          progress,
          priority: file.priority,
          retryCount: 0,
          status: getUploadStatus(item, progress),
        }
      }),
    )

const mapOnineQueue = (data: AthenaOnlineUploadQueueItem[]): UploadItem[] =>
  data.map((item) => {
    const { route, segment, filename } = parseUploadPath(item.url)
    const progress = formatProgress(item)
    return {
      id: item.id,
      route,
      segment,
      filename,
      uploadUrl: item.url,
      progress,
      priority: item.priority,
      retryCount: item.retry_count,
      status: getUploadStatus(item, progress),
    }
  })

export const useUploadQueue = (dongleId: string) => {
  const [items, setItems] = createStore({ online: [] as UploadItem[], offline: [] as UploadItem[] })
  const [loading, setLoading] = createSignal(true)
  const [onlineQueueError, setOnlineQueueError] = createSignal<string | undefined>()
  const [onlineTimeout, setOnlineTimeout] = createSignal<Timer>()
  const [offlineTimeout, setOfflineTimeout] = createSignal<Timer>()
  const [offlineQueueError, setOfflineQueueError] = createSignal<string | undefined>()
  const [clearQueueError, setClearQueueError] = createSignal<string | undefined>()
  const [clearingQueue, setClearingQueue] = createSignal(false)

  const onlinePollInterval = createMemo(() => (onlineQueueError() ? 5000 : 2000))
  const offlinePollInterval = createMemo(() => (offlineQueueError() ? 10000 : 5000))

  const clearQueue = async (items: UploadItem[]) => {
    if (clearingQueue() || items.length === 0) return
    setClearQueueError(undefined)
    setClearingQueue(true)

    try {
      await cancelUpload(
        dongleId,
        items.map((item) => item.id),
      )
    } catch (err) {
      console.debug('Error clearing queue:', err)
      setClearQueueError(`Error clearing queue: ${err}`)
    } finally {
      setClearingQueue(false)
    }
  }

  const pollOnlineQueue = async () => {
    if (onlineTimeout()) clearTimeout(onlineTimeout())
    setOnlineTimeout(undefined)

    try {
      const response = await getUploadQueue(dongleId)
      setItems('online', reconcile(mapOnineQueue(response.result!)))
      setOnlineQueueError(undefined)
    } catch (err) {
      if (err instanceof Error && err.cause instanceof Response && err.cause.status === 404) {
        setOnlineQueueError('Device offline')
      } else {
        console.error('Error polling online queue:', err)
        setOnlineQueueError(`Error checking device: ${err}`)
      }
    } finally {
      setLoading(false)
      setOnlineTimeout(setTimeout(pollOnlineQueue, onlinePollInterval()))
    }
  }

  const pollOfflineQueue = async () => {
    if (offlineTimeout()) clearTimeout(offlineTimeout())
    setOfflineTimeout(undefined)

    try {
      const offlineData = await getAthenaOfflineQueue(dongleId)
      setItems('offline', reconcile(mapOfflineQueue(offlineData)))
      setOfflineQueueError(undefined)
    } catch (err) {
      console.debug('Error polling offline queue:', err)
      setOfflineQueueError(`Error checking backlog: ${err}`)
    } finally {
      setOfflineTimeout(setTimeout(pollOfflineQueue, offlinePollInterval()))
    }
  }

  const offline = createMemo(() => onlineQueueError() !== undefined)

  const sortedItems = createMemo(() => {
    const allItems = [...items.offline, ...(offline() ? [] : items.online)]

    return allItems.sort((a, b) => {
      const statusDiff = getStatusPriority(a.status) - getStatusPriority(b.status)
      if (statusDiff !== 0) return statusDiff

      const routeDiff = a.route.localeCompare(b.route)
      if (routeDiff !== 0) return routeDiff

      const segmentDiff = a.segment - b.segment
      if (segmentDiff !== 0) return segmentDiff

      return a.filename.localeCompare(b.filename)
    })
  })

  onMount(() => {
    pollOnlineQueue()
    pollOfflineQueue()
  })

  onCleanup(() => {
    clearTimeout(onlineTimeout())
    clearTimeout(offlineTimeout())
  })

  return {
    clearQueue: () => void clearQueue(items.online),
    clearingQueue,
    clearQueueError,
    error: onlineQueueError,
    items: sortedItems,
    loading,
    offline,
  }
}
