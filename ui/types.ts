import type { ActiveFilter, EncodedDataset } from '../src/dashboards/core/types';
import type { ResolvedComponent, ResolvedFilter, ResolvedSpec } from '../src/dashboards/validate';
import type { Store } from './store';

/** A component as embedded in the page; markdown arrives pre-rendered (and sanitized) as html. */
export type ClientComponent = ResolvedComponent & { html?: string };

export interface ClientSpec extends Omit<ResolvedSpec, 'sections'> {
  sections: Array<{ title?: string; description?: string; items: ClientComponent[] }>;
}

export interface PagePayload {
  spec: ClientSpec;
  datasets: EncodedDataset[];
  meta: {
    builtAt: string;
    generator: string;
    runId?: string;
    /** standalone: a downloaded file; served: from the harness; embedded: a sandboxed viewer. */
    mode: 'standalone' | 'served' | 'embedded';
    notebook?: string;
  };
}

/** The component definition whose `type` admits T (line and area share one definition). */
export type ComponentOf<T extends ClientComponent['type']> = ClientComponent extends infer C
  ? C extends { type: infer U }
    ? T extends U
      ? C
      : never
    : never
  : never;

export interface App {
  store: Store;
  spec: ClientSpec;
  locale: string;
  downloads: boolean;
  filters: ResolvedFilter[];
  clearFilters(): void;
  /** Narrow a time field to [from, to) for a dataset (a chart brush). */
  setTimeRange(dataset: string, field: string, from: number, to: number, label: string): void;
  /** Toggle one value of a field (a click on a bar or cell). */
  toggleValue(dataset: string, field: string, value: string, label: string): void;
  isSelected(dataset: string, field: string, value: string): boolean;
  /** The filter holding a field's selected values: the spec's select filter, else a chart's. */
  selectionFor(dataset: string, field: string): ActiveFilter | undefined;
  clearValues(dataset: string, field: string): void;
}

export interface Component {
  el: HTMLElement;
  /** Datasets whose filters re-render this component. */
  datasets: string[];
  update(changed: Set<string>): void;
}
