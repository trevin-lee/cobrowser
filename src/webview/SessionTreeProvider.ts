import * as vscode from 'vscode';
import type { BrowserSession, PageInfo } from '../browser/BrowserSession';

/**
 * The Activity Bar sidebar: this workspace's browser and its open tabs, read through from the
 * session. Clicking a tab shows its editor tab, as clicking the editor tab itself would. With
 * no browser running the tree is empty, so VS Code shows the view's welcome text instead.
 */
export type TreeNode = ProfileNode | TabNode;
interface ProfileNode {
  kind: 'profile';
  label: string;
  tooltip: string;
}
interface TabNode {
  kind: 'tab';
  page: PageInfo;
}

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly profile: { label: string; path: string },
    /** Current session, or undefined before the browser is launched. */
    private readonly getSession: () => BrowserSession | undefined,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'profile') {
      // The row exists only while the browser runs (getChildren).
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = 'running';
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon('vm-active');
      item.contextValue = 'cobrowser.profile';
      return item;
    }

    const p = node.page;
    const item = new vscode.TreeItem(p.title || hostOf(p.url) || 'New Tab');
    // Only brings the page's editor tab forward; the panel's own focus handling does the rest,
    // exactly as when its editor tab is clicked.
    item.command = { command: 'cobrowser.showTab', title: 'Show Tab', arguments: [p.pageId] };
    item.description = hostOf(p.url);
    // The row clips a long title; the tooltip carries all of it.
    item.tooltip = [p.title, p.url, p.selected ? "The agent's tools act in this tab unless told another." : ''].filter(Boolean).join('\n');
    // Filled dot marks the tab the agent's tools act in by default; hollow for the rest.
    item.iconPath = new vscode.ThemeIcon(p.selected ? 'circle-filled' : 'circle-outline');
    item.contextValue = 'cobrowser.tab';
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      return this.getSession() ? [{ kind: 'profile', label: this.profile.label, tooltip: this.profile.path }] : [];
    }
    if (node.kind === 'profile') {
      const s = this.getSession();
      if (!s) return [];
      // Read straight from the session, not through a tab's queue: the list must not wait for
      // an agent's long action in the current tab.
      const pages = await s.listPages();
      return pages.map((page) => ({ kind: 'tab', page }));
    }
    return [];
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
