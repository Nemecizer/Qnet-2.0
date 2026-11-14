// Station pictures (0.90.34 `StationPicture`): the .bnet `picture` field keeps 0.90.34's SF Symbol
// name so files stay interchangeable; 2.0 draws a lucide icon through this fixed table (PLAN.md §4,
// "Replaced"). The drawing (src/canvas/layers) and the picker (src/panes/inspector) both read it.
import type { LucideIcon } from "lucide-react";
import { Cog, CreditCard, Cpu, Hammer, Package, Phone, Printer, Search, Server, Settings, ShoppingCart, Stethoscope, User, Users, UsersRound, Wrench } from "lucide-react";

export interface StationPicture {
  /** The raw value a .bnet stores; "" is No Picture. */
  readonly sf: string;
  readonly displayName: string;
  /** null for No Picture (a plain circle). */
  readonly icon: LucideIcon | null;
  /** The picker's group heading. */
  readonly group: "None" | "People" | "Manufacturing" | "Service" | "Logistics";
}

/** In 0.90.34's `CaseIterable` order. */
export const STATION_PICTURES: readonly StationPicture[] = [
  { sf: "", displayName: "No Picture", icon: null, group: "None" },
  { sf: "person.fill", displayName: "Operator", icon: User, group: "People" },
  { sf: "person.2.fill", displayName: "Two Operators", icon: Users, group: "People" },
  { sf: "person.3.fill", displayName: "Team", icon: UsersRound, group: "People" },
  { sf: "gearshape.2.fill", displayName: "Machine", icon: Cog, group: "Manufacturing" },
  { sf: "hammer.fill", displayName: "Workbench", icon: Hammer, group: "Manufacturing" },
  { sf: "wrench.and.screwdriver.fill", displayName: "Repair / Maintenance", icon: Wrench, group: "Manufacturing" },
  { sf: "printer.fill", displayName: "Printer / 3D Print", icon: Printer, group: "Manufacturing" },
  { sf: "cpu.fill", displayName: "Automated / Robot", icon: Cpu, group: "Manufacturing" },
  { sf: "stethoscope", displayName: "Healthcare", icon: Stethoscope, group: "Service" },
  { sf: "cart.fill", displayName: "Cashier", icon: ShoppingCart, group: "Service" },
  { sf: "creditcard.fill", displayName: "Teller / ATM", icon: CreditCard, group: "Service" },
  { sf: "phone.fill", displayName: "Call Center", icon: Phone, group: "Service" },
  { sf: "shippingbox.fill", displayName: "Package Box", icon: Package, group: "Logistics" },
  { sf: "magnifyingglass", displayName: "Inspection", icon: Search, group: "Logistics" },
  { sf: "server.rack", displayName: "Server Rack", icon: Server, group: "Logistics" },
  { sf: "gear", displayName: "Gear", icon: Settings, group: "Logistics" },
];

/** The picture for a stored raw value; an unknown name draws no picture (it is kept in the file). */
export function stationPicture(sf: string): StationPicture {
  return STATION_PICTURES.find((p) => p.sf === sf) ?? STATION_PICTURES[0];
}

/** `StationPicture.suggested(forServers:)`: one operator, two, or a team for three or more. */
export function suggestedPicture(servers: number): StationPicture {
  return stationPicture(servers <= 1 ? "person.fill" : servers === 2 ? "person.2.fill" : "person.3.fill");
}

export const isOperatorPicture = (sf: string) => sf === "person.fill" || sf === "person.2.fill" || sf === "person.3.fill";
