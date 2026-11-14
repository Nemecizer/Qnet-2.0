// The native menu bar in the browser preview: there is none, so menu_set keeps what it was sent
// (tests read it) and the page matches the shortcuts itself (src/lib/menu.ts installPreviewKeys).
import type { MenuNode } from "../../lib/menu";
import type { MockHandlers } from "../../test/tauri";

export const lastMenu: { nodes: MenuNode[] | null } = { nodes: null };

export function menuHandlers(): MockHandlers {
  return {
    menu_set: ({ menu }: { menu: MenuNode[] }) => {
      lastMenu.nodes = menu;
      return null;
    },
  };
}
