import type { Store, ManifestEntry } from '../store/store.ts';
import type { EntityDescriptor } from '../entities/types.ts';

export function listEntity(store: Store, desc: EntityDescriptor): Promise<ManifestEntry[]> {
  return store.listVersions(desc.kind);
}
