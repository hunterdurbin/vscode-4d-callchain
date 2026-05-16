/**
 * Static method/property signatures for 4D's built-in types.
 *
 * The chain walker consults this table when it can't resolve a step against
 * a user / component class — e.g. `$x.push(...)` on a Collection, or
 * `.first()` on an EntitySelection. Each entry's return type drives the next
 * step in the chain.
 *
 * Two special tokens handle ORDA parametric types:
 *   PARAM_ENTITY    — the entity class T from `EntitySelection<T>` / `Entity<T>`.
 *   PARAM_SELECTION — `EntitySelection<T>` preserving T.
 *
 * Return type `""` means the method's return type is irrelevant (void or not
 * usefully chainable) — the walker stops there.
 */

export const PARAM_ENTITY = "__paramEntity__";
export const PARAM_SELECTION = "__paramSelection__";

export type BuiltinReturn = string;

export const BUILTIN_TYPE_BASES = new Set<string>([
  "EntitySelection", "Entity", "DataClass",
  "Collection", "Object",
  "Date", "Time",
  "Number", "Text", "Boolean",
  "Picture", "Blob", "Formula"
]);

export const BUILTIN_TYPE_API: Record<string, Record<string, BuiltinReturn>> = {
  // -------- ORDA --------
  EntitySelection: {
    first: PARAM_ENTITY,
    last: PARAM_ENTITY,
    query: PARAM_SELECTION,
    orderBy: PARAM_SELECTION,
    orderByFormula: PARAM_SELECTION,
    slice: PARAM_SELECTION,
    and: PARAM_SELECTION,
    or: PARAM_SELECTION,
    minus: PARAM_SELECTION,
    add: PARAM_SELECTION,
    copy: PARAM_SELECTION,
    clone: PARAM_SELECTION,
    refresh: "",
    drop: "",
    toCollection: "Collection",
    distinct: "Collection",
    extract: "Collection",
    indexOf: "Number",
    length: "Number",
    count: "Number",
    sum: "Number",
    average: "Number",
    min: "Number",
    max: "Number",
    contains: "Boolean",
    getDataClass: "DataClass",
    isAlterable: "Boolean",
    isOrdered: "Boolean",
    selected: PARAM_SELECTION,
    toJSON: "Text",
  },
  Entity: {
    save: PARAM_ENTITY,
    drop: "",
    lock: "Boolean",
    unlock: "",
    refresh: "",
    reload: PARAM_ENTITY,
    next: PARAM_ENTITY,
    previous: PARAM_ENTITY,
    first: PARAM_ENTITY,
    last: PARAM_ENTITY,
    isNew: "Boolean",
    diff: "Collection",
    touched: "Boolean",
    touchedAttributes: "Collection",
    getDataClass: "DataClass",
    getKey: "Text",
    getStamp: "Number",
    getSelection: PARAM_SELECTION,
    toObject: "Object",
    fromObject: PARAM_ENTITY,
    clone: PARAM_ENTITY,
    isAlterable: "Boolean",
  },
  DataClass: {
    new: PARAM_ENTITY,
    all: PARAM_SELECTION,
    query: PARAM_SELECTION,
    fromCollection: PARAM_SELECTION,
    get: PARAM_ENTITY,
    fromObject: PARAM_ENTITY,
    getCount: "Number",
    getInfo: "Object",
    newSelection: PARAM_SELECTION,
    setRemoteCacheSettings: "",
    clearRemoteCache: "",
    indices: "Collection",
    getName: "Text",
    attributeName: "Text",
  },

  // -------- Collections --------
  Collection: {
    push: "Collection",
    pop: "Object",
    shift: "Object",
    unshift: "Collection",
    slice: "Collection",
    concat: "Collection",
    combine: "Collection",
    sort: "Collection",
    orderBy: "Collection",
    reverse: "Collection",
    filter: "Collection",
    map: "Collection",
    reduce: "Object",
    extract: "Collection",
    query: "Collection",
    distinct: "Collection",
    indexOf: "Number",
    lastIndexOf: "Number",
    indices: "Collection",
    includes: "Boolean",
    every: "Boolean",
    some: "Boolean",
    find: "Object",
    findIndex: "Number",
    length: "Number",
    count: "Number",
    countValues: "Number",
    sum: "Number",
    average: "Number",
    min: "Object",
    max: "Object",
    join: "Text",
    copy: "Collection",
    insert: "Collection",
    remove: "Collection",
    resize: "Collection",
    fill: "Collection",
    clear: "Collection",
  },

  // -------- Object --------
  Object: {
    toString: "Text",
    toJSON: "Text",
  },

  // -------- Date / Time --------
  Date: {
    add: "Date",
    monthOf: "Number",
    dayOf: "Number",
    yearOf: "Number",
    dayNumber: "Number",
    date: "Date",
    string: "Text",
    toString: "Text",
  },
  Time: {
    string: "Text",
    toString: "Text",
  },

  // -------- Scalars --------
  Number: {
    toString: "Text",
  },
  Text: {
    length: "Number",
    substring: "Text",
    split: "Collection",
    replace: "Text",
    toUppercase: "Text",
    toLowercase: "Text",
    toString: "Text",
  },
  Boolean: {
    toString: "Text",
  },

  // -------- Misc --------
  Picture: {
    toString: "Text",
  },
  Blob: {
    toString: "Text",
  },
  Formula: {
    call: "Object",
    apply: "Object",
    source: "Text",
    toString: "Text",
  },
};

/**
 * Split a canonical type string into its base name and optional parameter.
 *   `EntitySelection<Foo>` → { base: "EntitySelection", param: "Foo" }
 *   `Collection`           → { base: "Collection", param: undefined }
 */
export function splitBuiltin(type: string): { base: string; param?: string } | undefined {
  const m = type.match(/^([A-Za-z_][\w_]*)(?:<(.+)>)?$/);
  if (!m) return undefined;
  return { base: m[1], param: m[2] };
}
