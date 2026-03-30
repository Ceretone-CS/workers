function syncTagsFromTickets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ticketsSheet = ss.getSheetByName("Tickets");
  const tagsSheet = ss.getSheetByName("Tags");

  if (!ticketsSheet) throw new Error('Missing sheet: Tickets');
  if (!tagsSheet) throw new Error('Missing sheet: Tags');

  const lastTicketRow = ticketsSheet.getLastRow();
  if (lastTicketRow < 2) return;

  // Column I = Tags after the ticket layout change
  const tagValues = ticketsSheet.getRange(2, 9, lastTicketRow - 1, 1).getValues().flat();

  const parsedTags = new Set();
  tagValues.forEach(value => {
    if (!value) return;
    String(value)
      .split(',')
      .map(tag => tag.trim().toLowerCase())
      .filter(Boolean)
      .forEach(tag => parsedTags.add(tag));
  });

  const lastTagRow = tagsSheet.getLastRow();
  if (lastTagRow === 0) {
    tagsSheet.getRange(1, 1).setValue('Tag');
  }

  const existingTags = new Set(
    Math.max(tagsSheet.getLastRow() - 1, 0) > 0
      ? tagsSheet.getRange(2, 1, tagsSheet.getLastRow() - 1, 1).getValues()
          .flat()
          .map(v => String(v).trim().toLowerCase())
          .filter(Boolean)
      : []
  );

  const newTags = Array.from(parsedTags)
    .filter(tag => !existingTags.has(tag))
    .sort();

  if (!newTags.length) return;

  const startRow = tagsSheet.getLastRow() + 1;
  const range = tagsSheet.getRange(startRow, 1, newTags.length, 1);
  range.setValues(newTags.map(tag => [tag]));
  range.setBackground('#fff2cc');

  if (tagsSheet.getLastRow() > 1) {
    tagsSheet.getRange(2, 1, tagsSheet.getLastRow() - 1, 1).sort({ column: 1, ascending: true });
  }
}
