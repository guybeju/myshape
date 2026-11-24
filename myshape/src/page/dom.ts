// A tiny element builder. The page never assigns HTML strings, so text from
// agents and topics is always inserted as text.

export type Child = Node | string | number | null | undefined | false | Child[];
type Listener = (event: Event) => void;
export type Props = Record<string, string | number | boolean | Listener | null | undefined>;

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) child.forEach((entry) => append(parent, entry));
  else parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

function applyProp(
  element: HTMLElement,
  name: string,
  value: string | number | true | Listener,
): void {
  if (typeof value === "function") element.addEventListener(name.slice(2), value);
  else if (name === "class") element.className = String(value);
  else if (name === "value") (element as HTMLInputElement).value = String(value);
  else element.setAttribute(name, value === true ? "" : String(value));
}

/** Creates an element. `on*` props are listeners, `class` is the class name, the rest are attributes. */
export function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value !== null && value !== undefined && value !== false) applyProp(element, name, value);
  }
  append(element, children);
  return element;
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.textContent = "";
  append(parent, children);
}
