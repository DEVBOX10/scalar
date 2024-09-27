import { useWorkspace } from '@/store'
import { specDictionary } from '@/store/import-spec'
import {
  type Collection,
  type Request,
  type Server,
  type Tag,
  serverSchema,
  tagSchema,
} from '@scalar/oas-utils/entities/spec'
import { createHash, fetchSpecFromUrl } from '@scalar/oas-utils/helpers'
import { parseSchema } from '@scalar/oas-utils/transforms'
import { getNestedValue } from '@scalar/object-utils/nested'
import { useTimeoutPoll } from '@vueuse/core'
import microdiff, { type Difference } from 'microdiff'
import { watch } from 'vue'

/** Build a payload for updating specific properties, only works with objects */
const buildPayload = (diff: Difference, resource: Collection | Server) => {
  const path = [...diff.path]

  const key = path.pop()
  if (!key) return null

  // If we are indexing a resource, then we don't need the first couple path items
  const value =
    typeof path[1] === 'number'
      ? resource
      : getNestedValue(resource, path.join('.') as keyof typeof resource)

  // Destructure to remove the property from the object
  if (diff.type === 'REMOVE') {
    const { [key]: removeMe, ...rest } = value
    return rest
  }
  // Add or edit the property
  else {
    return { ...value, [key]: diff.value }
  }
}

/** Like array.find but returns the resource instead of the uid */
const findResource = <T>(
  arr: string[],
  resources: Record<string, T>,
  condtion: (resource: T) => boolean,
) => {
  for (let i = 0; i < arr.length; i++) {
    const r = resources[arr[i]]
    if (condtion(r)) return r
  }
  return null
}

/**
 * Hook which handles polling the documentUrl for changes then attempts to merge what is new
 *
 * Currently we will hash the
 */
export const useLiveSync = () => {
  const {
    activeCollection,
    activeWorkspace,
    collectionMutators,
    requests,
    requestMutators,
    servers,
    serverMutators,
    tags,
    tagMutators,
  } = useWorkspace()

  /** Live Sync polling timeout */
  const FIFTEEN_SECONDS = 5 * 1000

  const { pause, resume } = useTimeoutPoll(async () => {
    const url = activeCollection.value?.documentUrl
    if (!url) return

    const old = specDictionary[url]

    // Grab the new spec
    const spec = await fetchSpecFromUrl(
      url,
      activeWorkspace.value.proxyUrl,
      false,
    )
    const hash = createHash(spec)

    // If we have no previous copy then store this one
    if (!old?.hash) {
      const { schema } = await parseSchema(spec)

      if (schema)
        specDictionary[url] = {
          hash,
          schema,
        }
    }
    // If the hashes do not match, start diffin
    else if (old.hash && old.hash !== hash) {
      const { schema } = await parseSchema(spec)
      const diff = microdiff(old.schema, schema)

      console.log(diff)

      diff
        .forEach((d) => {
        const { path, type } = d
        if (!path.length || !activeCollection.value?.uid) return

        // Info
        if (path[0] === 'info') {
          const payload = buildPayload(d, activeCollection.value)
          if (!payload) return

          // Property path is all but the last item
          const prop = d.path
            .slice(0, d.path.length - 1)
            .join('.') as keyof Collection
          collectionMutators.edit(activeCollection.value?.uid, prop, payload)
        }
        // Servers
        else if (path[0] === 'servers') {
          const [, index, key] = path as ['servers', number, keyof Server]

          // TODO: server variables
          if (key === 'variables') {
            console.warn(
              'Live Sync: Syncing server variables are not supported at this time, please open a github issue if you would like to see this added.',
            )
            return
          }

          // Edit: update properties
          if (key) {
            const serverUid = activeCollection.value.servers[index]
            const server = servers[serverUid]

            if (!server) {
              console.warn('Live Sync: Server not found, update not applied')
              return
            }

            serverMutators.edit(serverUid, key, d.value)
          }
          // Delete whole object
          else if (type === 'REMOVE') {
            const serverUid = activeCollection.value.servers[index]
            if (serverUid)
              serverMutators.delete(serverUid, activeCollection.value.uid)
            else console.warn('Live Sync: Server not found, update not applied')
          }
          // Add whole object
          else if (type === 'CREATE')
            serverMutators.add(
              serverSchema.parse(d.value),
              activeCollection.value.uid,
            )
        }
        // TODO: security
        // Tags
        else if (path[0] === 'tags') {
          const [, index, key] = path as ['tags', number, keyof Tag]

          // Edit: update properties
          if (key) {
            const uid = activeCollection.value.tags[index]
            const tag = tags[uid]

            if (!tag) {
              console.warn('Live Sync: Tag not found, update not applied')
              return
            }

            tagMutators.edit(uid, key, d.value)
          }
          // Delete whole object
          else if (type === 'REMOVE') {
            const uid = activeCollection.value.tags[index]
            if (uid) tagMutators.delete(tags[uid], activeCollection.value.uid)
            else console.warn('Live Sync: Tag not found, update not applied')
          }
          // Add whole object
          else if (type === 'CREATE')
            tagMutators.add(
              tagSchema.parse(d.value),
              activeCollection.value.uid,
            )
        }
        // Paths
        else if (path[0] === 'paths') {
          const [, _path, method, property] = path as [
            'paths',
            Request['path'],
            Request['method'],
            keyof Request,
          ]
          console.log(_path, method, property)
          
          // Path change
          if (!method)

          // Find the request
          const request = findResource<Request>(
            activeCollection.value.requests,
            requests,
            (r) => r.path === _path && r.method === method,
          )
          console.log(request)
          // Primitive properties
          if (['summary', 'description', 'operationId', 'deprecated'].includes(property) && request) 
            requestMutators.edit(request.uid, property, d.value)
          
        }
      })

      // Update the dict
      specDictionary[url] = {
        hash,
        schema,
      }
    } else console.log('nothing to see here')
  }, FIFTEEN_SECONDS)

  // Ensure we are only polling when we should liveSync
  watch(
    [
      () => activeCollection.value?.documentUrl,
      () => activeCollection.value?.liveSync,
    ],
    ([documentUrl, liveSync]) => {
      if (documentUrl && liveSync) resume()
      else pause()
    },
    { immediate: true },
  )
}
