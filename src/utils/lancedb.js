/**
 * Read a LanceDB table schema across SDK versions.
 *
 * @param {import('@lancedb/lancedb').Table} table - LanceDB table
 * @returns {Promise<import('apache-arrow').Schema|null>} Table schema
 */
export async function getTableSchema(table) {
  if (!table) {
    return null;
  }

  if (typeof table.schema === 'function') {
    return table.schema();
  }

  return table.schema ?? null;
}

/**
 * Check whether a LanceDB schema has a field.
 *
 * @param {import('apache-arrow').Schema|null|undefined} schema - LanceDB table schema
 * @param {string} fieldName - Field name
 * @returns {boolean} Whether the schema contains the field
 */
export function schemaHasField(schema, fieldName) {
  return Boolean(schema?.fields?.some((field) => field.name === fieldName));
}
