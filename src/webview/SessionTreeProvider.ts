import * as vscode from 'vscode';
import type { BrowserSession, PageInfo } from '../browser/BrowserSession';

/**
 * The Activity Bar sidebar: a tree of browser profile(s) and their open tabs.
 *
 * The spike runs a single persistent profile, so today the root is one profile
 * node; the structure leaves room for more later. Each profile's children are
 * its live pages (from `listPages()`), so this is a read-through view of the
 * session — clicking a tab reveals that page's editor panel.
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
      const running = this.getSession() !== undefined;
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = running ? 'running' : 'stopped';
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon(running ? 'vm-active' : 'vm-outline');
      item.contextValue = 'cobrowser.profile';
      return item;
    }

    const p = node.page;
    const item = new vscode.TreeItem(p.title || hostOf(p.url) || 'New tab');
    item.description = hostOf(p.url);
    item.tooltip = p.url;
    // Filled dot marks the active (foreground) tab; hollow for the rest.
    item.iconPath = new vscode.ThemeIcon(p.selected ? 'circle-filled' : 'circle-outline');
    item.contextValue = 'cobrowser.tab';
    item.command = {
      command: 'cobrowser.revealTab',
      title: 'Reveal Tab',
      arguments: [p.pageId],
    };
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      return [{ kind: 'profile', label: this.profile.label, tooltip: this.profile.path }];
    }
    if (node.kind === 'profile') {
      const s = this.getSession();
      if (!s) return [];
      const pages = await s.run(() => s.listPages());
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
