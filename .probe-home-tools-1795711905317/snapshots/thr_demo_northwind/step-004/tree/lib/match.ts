export interface BankRow {
  id: string;
  amount: number;
  currency: string;
  reference: string;
}

export interface Invoice {
  id: string;
  amount: number;
  currency: string;
  reference: string;
}

/** Exact reference + amount match; everything else is an exception. */
export function matchRows(rows: BankRow[], invoices: Invoice[]) {
  const byReference = new Map(invoices.map((invoice) => [invoice.reference, invoice]));
  const matched: Array<{ row: BankRow; invoice: Invoice }> = [];
  const exceptions: BankRow[] = [];
  for (const row of rows) {
    const invoice = byReference.get(row.reference);
    if (invoice && invoice.amount === row.amount && invoice.currency === row.currency) {
      matched.push({ row, invoice });
    } else {
      exceptions.push(row);
    }
  }
  return { matched, exceptions };
}
