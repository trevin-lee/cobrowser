/** Run by VS Code once the extension is uninstalled (package.json: vscode:uninstall), in plain
 *  Node with no editor API: take cobrowser's entries out of the agents' configs. */
import { unregisterEverywhere } from './clients/unregister';

unregisterEverywhere();
