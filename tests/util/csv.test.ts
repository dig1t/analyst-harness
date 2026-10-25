import { parseCsv, parseCsvRows, toCsv } from '../../src/util/csv';

describe('csv', () => {
  test('parses quotes, doubled quotes, embedded delimiters and line breaks', () => {
    const text = '\ufeffname,note\r\n"Smith, J.","said ""hi""\nthen left"\r\nplain,x\n';
    expect(parseCsvRows(text)).toEqual([
      ['name', 'note'],
      ['Smith, J.', 'said "hi"\nthen left'],
      ['plain', 'x'],
    ]);
  });

  test('builds objects from the header, fills short rows and renames duplicates', () => {
    const { columns, rows } = parseCsv('a,a,,b\n1,2,3\n');
    expect(columns).toEqual(['a', 'a_2', 'column_3', 'b']);
    expect(rows).toEqual([{ a: '1', a_2: '2', column_3: '3', b: '' }]);
    expect(parseCsv('1;2\n3;4', { delimiter: ';', header: false }).rows).toEqual([
      { column_1: '1', column_2: '2' },
      { column_1: '3', column_2: '4' },
    ]);
    expect(parseCsv('title line\nx,y\n1,2', { skipRows: 1 }).rows).toEqual([{ x: '1', y: '2' }]);
    expect(parseCsv('')).toEqual({ columns: [], rows: [] });
  });

  test('serializes with quoting only where needed and round-trips', () => {
    const rows = [
      { id: 1, text: 'a,b', quote: 'say "x"', obj: { k: 1 }, empty: null },
      { id: 2, text: ' padded ', quote: 'line\nbreak' },
    ];
    const csv = toCsv(rows);
    expect(csv.split('\r\n')[0]).toBe('id,text,quote,obj,empty');
    expect(csv).toContain('"a,b","say ""x""","{""k"":1}",');
    const back = parseCsv(csv).rows;
    expect(back[1]).toMatchObject({ id: '2', text: ' padded ', quote: 'line\nbreak', obj: '', empty: '' });
    expect(toCsv([{ a: 1 }], ['b', 'a'])).toBe('b,a\r\n,1\r\n');
  });
});
