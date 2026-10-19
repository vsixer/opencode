export * as ReloadService from "./reload-service.js"

import { Context, Effect, Layer } from "effect"
import { Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FileSystem } from "../filesystem.js"
import { LocationServiceMap } from "../location-service-map.js"

export interface Interface {
  /** Invalidate and rebuild every Location's service graph, picking up config changes. */
  readonly reload: () => Effect.Effect<void, FileSystem.DirectoryNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReloadService") {}

/**
 * Bridges a Location-scoped consumer (the reload_config tool) to the global
 * LocationServiceMap: the map is not part of the Location plugin service set,
 * so it is captured here through the node dependency and replaced inside the
 * Location graph at boot. The declared provider type keeps the initializer out
 * of the Instance.Services type-evaluation cycle the map's type participates in.
 */
export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.location> =
  Node.makeLocationNode({
    service: Service,
    layer: Layer.effect(
      Service,
      Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        return Service.of({
          reload: () =>
            LocationServiceMap.reload().pipe(Effect.provideService(LocationServiceMap.Service, locations)),
        })
      }),
    ),
    deps: [LocationServiceMap.node],
  })
