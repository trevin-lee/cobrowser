/**
 * Which editor group a new browser tab should open in.
 *
 * Pure so the rule can be tested: getting it wrong fragments the human's editor into a new
 * split per browser tab, which is invisible to a type check and only shows up in daily use.
 */
export function pickColumn(opts: {
  /** A column recorded before a reload, replaying the pre-reload split. Wins outright. */
  planned?: number;
  /** The pane cobrowser has already claimed. */
  dedicated?: number;
  /** Columns of panels that happen to be visible right now (often empty — VS Code reports
   *  undefined for any panel that is not the active tab in its group). */
  liveColumns?: (number | undefined)[];
}): number | undefined {
  const { planned, dedicated, liveColumns = [] } = opts;
  if (planned != null) return planned;
  if (dedicated != null) return dedicated;
  return liveColumns.find((c) => c != null);
}
