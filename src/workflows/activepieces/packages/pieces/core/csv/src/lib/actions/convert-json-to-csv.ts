import { createAction, Property } from '@activepieces/pieces-framework';
import { flatten } from 'safe-flat';
import { stringify } from "csv-stringify/sync";

const markdown = `
**Notes**:
* The input should be a JSON array.
* The JSON object will be flattened If nested and the keys will be used as headers.
`
export const jsonToCsvAction = createAction({
  name: 'convert_json_to_csv',
  displayName: 'Convert JSON to CSV',
  description: 'This function reads a JSON array and converts it into CSV format.',
  errorHandlingOptions: {
    continueOnFailure: { hide: true },
    retryOnFailure: { hide: true },
  },
  props: {
    markdown: Property.MarkDown({
      value: markdown,
    }),
    json_array: Property.Json({
      displayName: 'JSON Array',
      defaultValue: [
        {
          name: 'John',
          age: 30,
          address: {
            street: '123 Main St',
            city: 'Los Angeles',
          }
        },
        {
          name: 'Jane',
          age: 25,
          address: {
            street: '123 Main St',
            city: 'Los Angeles',
          }
        }
      ],
      description:
        'Provide a JSON array to convert to CSV format.',
      required: true,
    }),
    delimiter_type: Property.StaticDropdown({
      displayName: 'Delimiter Type',
      description: 'Select the delimiter type for the CSV file.',
      defaultValue: ',',
      required: true,
      options: {
        options: [
          { label: 'Comma', value: ',' },
          { label: 'Tab', value: '\t' },
        ],
      },
    }),
  },
  async run(context) {
    const { json_array, delimiter_type } = context.propsValue;
    if (!Array.isArray(json_array)) {
      throw new Error(JSON.stringify({
        message: 'The input should be a JSON array.',
      }))
    }
    const flattened = json_array.map((item) => flatten(item) as Record<string, string>);

    // === JARVIS PATCH: the header is every key of every row ===
    // Upstream took the header from the first row, so a column only a later row
    // had was dropped, with its values, and the step still succeeded. Keys are
    // listed in first-seen order; a row without a key gets an empty cell.
    // Cells are read as own properties and handed over by position: given an
    // object row, csv-stringify resolves a column like `tags.0` as a path, so a
    // row whose `tags` is the string "foo" would get "f", and a row without
    // `toString` would read the prototype's function and fail the step.
    const isRow = (row: unknown): row is Record<string, unknown> =>
      row !== null && typeof row === 'object' && !Array.isArray(row);
    const columns = [...new Set(flattened.flatMap((row) => (isRow(row) ? Object.keys(row) : [])))];
    if (columns.length > 0) {
      const cells = flattened.map((row) =>
        isRow(row) ? columns.map((key) => (Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined)) : row,
      );
      return stringify(cells, {
        header: true,
        delimiter: delimiter_type,
        columns,
      });
    }
    return stringify(flattened, {
      header: true,
      delimiter: delimiter_type,
    });
    // === END JARVIS PATCH ===
  },
});
