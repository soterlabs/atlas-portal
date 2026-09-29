import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UuidMappings } from '@/app/server/atlas/load-uuid-mapping';
import ContentTree from '../content-tree';

describe('ContentTree', () => {
  it('does not log to the console on render', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const mappings = { notionPageIDsToAtlasUUIDs: {}, atlasUUIDsToNotionPageIds: {} } as unknown as UuidMappings;
    render(<ContentTree scopeTreesWithoutAgents={[]} uuidMappings={mappings} />);
    expect(log).not.toHaveBeenCalledWith('Rendering ContentTree');
    log.mockRestore();
  });
});
