import { createQuery } from '@tanstack/solid-query'
import { For, Show, Suspense, VoidComponent } from 'solid-js'
import { cancelUpload, COMMA_CONNECT_PRIORITY, getUploadQueue } from '~/api/athena'
import { UploadFilesToUrlsRequest, UploadQueueItem } from '~/types'
import LinearProgress from './material/LinearProgress'
import Icon from './material/Icon'
import { getAthenaOfflineQueue } from '~/api/devices'
import IconButton from './material/IconButton'
import StatisticBar from './StatisticBar'
import { createStore, reconcile } from 'solid-js/store'

interface DecoratedUploadQueueItem extends UploadQueueItem {
  route: string
  segment: number
  filename: string
}

const parseUploadPath = (url: string) => {
  const parts = new URL(url).pathname.split('/')
  return { route: parts[3], segment: parseInt(parts[4], 10), filename: parts[5] }
}

const cancel = (dongleId: string, ids: string[]) => {
  if (ids.length === 0) return
  cancelUpload(dongleId, ids).catch((error) => {
    console.error('Error canceling uploads', error)
  })
}

const UploadQueueRow: VoidComponent<{ dongleId: string; item: DecoratedUploadQueueItem }> = ({ dongleId, item }) => {
  return (
    <div class="flex flex-col">
      <div class="flex items-center justify-between flex-wrap mb-1 gap-x-4 min-w-0">
        <div class="flex items-center min-w-0 flex-1">
          <Icon
            class="text-on-surface-variant flex-shrink-0 mr-2"
            name={item.priority === COMMA_CONNECT_PRIORITY ? 'person' : 'local_fire_department'}
          />
          <div class="flex min-w-0 gap-1">
            <span class="text-body-sm font-mono truncate text-on-surface">{[item.route, item.segment, item.filename].join(' ')}</span>
          </div>
        </div>
        <div class="flex items-center gap-0.5 flex-shrink-0 justify-end">
          <Show
            when={!item.id || item.progress !== 0}
            fallback={<IconButton class="text-red-300" size="20" name="close_small" onClick={() => cancel(dongleId, [item.id])} />}
          >
            <span class="text-body-sm font-mono whitespace-nowrap pr-[0.5rem]">
              {item.id ? `${Math.round(item.progress * 100)}%` : 'Offline'}
            </span>
          </Show>
        </div>
      </div>
      <div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
        <LinearProgress progress={item.progress} color={Math.round(item.progress * 100) === 100 ? 'tertiary' : 'primary'} />
      </div>
    </div>
  )
}

const UploadQueue: VoidComponent<{ dongleId: string }> = (props) => {
  const onlineQueue = createQuery(() => ({
    queryKey: ['online_queue', props.dongleId],
    queryFn: () => getUploadQueue(props.dongleId),
    select: (data) => data.result?.map((item) => ({ ...item, ...parseUploadPath(item.url) })).sort((a, b) => b.progress - a.progress) || [],
    retry: false,
    refetchInterval: 1000,
  }))

  const offlineQueue = createQuery(() => ({
    queryKey: ['offline_queue', props.dongleId],
    queryFn: () => getAthenaOfflineQueue(props.dongleId),
    enabled: onlineQueue.status !== 'success',
    select: (data) =>
      data
        ?.filter((item) => item.method === 'uploadFilesToUrls')
        .flatMap((item) =>
          (item.params as UploadFilesToUrlsRequest).files_data.map((file) => ({
            ...file,
            ...parseUploadPath(file.url),
            path: file.fn,
            created_at: 0,
            current: false,
            id: '',
            progress: 0,
            retry_count: 0,
          })),
        ) || [],
    retry: false,
    refetchInterval: 5000,
  }))

  const [itemStore, setItemStore] = createStore<DecoratedUploadQueueItem[]>([])
  const items = () => {
    // only check data (triggering suspense boundary) if haven't fetched yet
    const online = !onlineQueue.isFetched || onlineQueue.status === 'success' ? onlineQueue.data : []
    const offline = offlineQueue.data ?? []

    setItemStore(reconcile([...(online || []), ...(offline || [])]))

    return itemStore
  }

  const cancelAll = () =>
    cancel(
      props.dongleId,
      items().map((item) => item.id),
    )

  return (
    <div class="flex flex-col gap-4 bg-surface-container-lowest">
      <div class="flex p-4 justify-between items-center border-b-2 border-b-surface-container-low">
        <StatisticBar statistics={[{ label: 'Queued', value: () => items().length }]} />
        <IconButton name="close" onClick={cancelAll} />
      </div>
      <div class="relative h-[calc(4*3rem)] sm:h-[calc(6*3rem)] flex justify-center items-center text-on-surface-variant">
        <Suspense
          fallback={
            <div class="flex items-center gap-2">
              <Icon name="autorenew" class="animate-spin" />
              <div>Waiting for device to connect...</div>
            </div>
          }
        >
          <Show
            when={items().length > 0}
            fallback={
              <div class="flex items-center gap-2">
                <Icon name={onlineQueue.isFetched && !onlineQueue.isSuccess ? 'error' : 'check'} class="mr-2" />
                <div>{onlineQueue.isFetched && !onlineQueue.isSuccess ? 'Device offline' : 'Nothing to upload'}</div>
              </div>
            }
          >
            <div class="absolute inset-0 bottom-4 flex flex-col gap-2 px-4 overflow-y-auto hide-scrollbar">
              <For each={items()}>{(item) => <UploadQueueRow dongleId={props.dongleId} item={item} />}</For>
            </div>
          </Show>
        </Suspense>
      </div>
    </div>
  )
}

export default UploadQueue
