import { getTableSchema, schemaHasField } from './lancedb.js';

describe('LanceDB utilities', () => {
  describe('getTableSchema', () => {
    it('should call method-style schema APIs', async () => {
      const schema = { fields: [{ name: 'project_path' }] };
      const table = {
        schema: vi.fn().mockResolvedValue(schema),
      };

      await expect(getTableSchema(table)).resolves.toBe(schema);
      expect(table.schema).toHaveBeenCalledOnce();
    });

    it('should read property-style schema APIs', async () => {
      const schema = { fields: [{ name: 'project_path' }] };
      const table = { schema };

      await expect(getTableSchema(table)).resolves.toBe(schema);
    });

    it('should return null for missing tables or schemas', async () => {
      await expect(getTableSchema(null)).resolves.toBeNull();
      await expect(getTableSchema({})).resolves.toBeNull();
    });
  });

  describe('schemaHasField', () => {
    it('should check fields by name', () => {
      expect(schemaHasField({ fields: [{ name: 'project_path' }] }, 'project_path')).toBe(true);
      expect(schemaHasField({ fields: [{ name: 'other' }] }, 'project_path')).toBe(false);
      expect(schemaHasField(null, 'project_path')).toBe(false);
    });
  });
});
