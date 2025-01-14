export type JsonObject =
  | { [Key in string]: JsonValue }
  | { [Key in string]?: JsonValue };

export type JsonArray = JsonValue[] | readonly JsonValue[];

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface BaseOperation {
  path: string;
}

export interface AddOperation<T = any> extends BaseOperation {
  op: 'add';
  value: T;
}

export interface RemoveOperation extends BaseOperation {
  op: 'remove';
}

export interface ReplaceOperation<T = any> extends BaseOperation {
  op: 'replace';
  value: T;
}

export interface MoveOperation extends BaseOperation {
  op: 'move';
  from: string;
}

export interface CopyOperation extends BaseOperation {
  op: 'copy';
  from: string;
}

export interface TestOperation<T = any> extends BaseOperation {
  op: 'test';
  value: T;
}

export type Operation =
  | AddOperation
  | RemoveOperation
  | ReplaceOperation
  | MoveOperation
  | CopyOperation
  | TestOperation;

export type Patch = Operation[];

export type GeneratePatchContext = {
  side: 'left' | 'right';
  path: string;
};

export type ObjectHash = (
  obj: JsonValue,
  context: GeneratePatchContext
) => string;

export type PropertyFilter = (
  propertyName: string,
  context: GeneratePatchContext
) => boolean;

export type JsonPatchConfig = {
  objectHash?: ObjectHash;
  propertyFilter?: PropertyFilter;
  array?: { ignoreMove?: boolean };
};

export function generateJSONPatch(
  before: JsonValue,
  after: JsonValue,
  config: JsonPatchConfig = {}
): Patch {
  const { objectHash, propertyFilter } = config;
  const patch: Patch = [];
  const hasPropertyFilter = typeof propertyFilter === 'function';

  // TODO: detect move by reference or identical primitive value, this should be a config flag
  /*
    Maybe we can just use a default objectHash for indexed array comparison that creates hashes of the value :thinking:
     */
  function compareArrayByIndex(
    leftArr: JsonArray,
    rightArr: JsonArray,
    path: string
  ) {
    let currentIndex = 0;
    const maxLength = Math.max(leftArr.length, rightArr.length);
    for (let i = 0; i < maxLength; i++) {
      const newPathIndex = `${path}/${currentIndex++}`;
      // we have elements on both sides
      if (i < leftArr.length && i < rightArr.length) {
        compareObjects(newPathIndex, leftArr[i], rightArr[i]);
        // we only have elements on arr 2
      } else if (i >= leftArr.length && i < rightArr.length) {
        patch.push({ op: 'add', path: newPathIndex, value: rightArr[i] });
        // we only have elements on arr 1
      } else if (i < leftArr.length && i >= rightArr.length) {
        patch.push({ op: 'remove', path: newPathIndex });
        // we need to decrement the current index for further operations
        currentIndex--;
      }
    }
  }

  function compareArrayByHash(
    leftArr: JsonArray,
    rightArr: JsonArray,
    path: string
  ) {
    if (typeof objectHash !== 'function') {
      throw Error('No objectHash function provided');
    }

    const leftHashes = leftArr.map((value) =>
      objectHash(value, { side: 'left', path })
    );
    const rightHashes = rightArr.map((value) =>
      objectHash(value, { side: 'right', path })
    );
    let currentIndex = 0;

    const targetHashes: string[] = [];

    for (let i = 0; i < leftHashes.length; i++) {
      const newPathIndex = `${path}/${currentIndex++}`;
      const rightHashIndex = rightHashes.indexOf(leftHashes[i]);

      // matched by hash (exists on both sides) - compare elements
      if (rightHashIndex >= 0) {
        compareObjects(newPathIndex, leftArr[i], rightArr[rightHashIndex]);
        targetHashes.push(leftHashes[i]);
      } else {
        // only exists on left, we remove it
        patch.push({ op: 'remove', path: newPathIndex });
        currentIndex--;
      }
    }

    const toBeAddedHashes = rightHashes.filter(
      (hash) => !targetHashes.includes(hash)
    );

    for (const toBeAddedHash of toBeAddedHashes) {
      patch.push({
        op: 'add',
        path: `${path}/${currentIndex++}`,
        value: rightArr[rightHashes.indexOf(toBeAddedHash)],
      });
      targetHashes.push(toBeAddedHash);
    }

    if (config.array?.ignoreMove) {
      return;
    }

    // we calculate all move operations and add them at the end.
    // This way, we can always ignore them when we apply the resulting patch
    for (let i = rightHashes.length - 1; i >= 0; i--) {
      const hash = rightHashes[i];
      const targetIndex = rightHashes.indexOf(hash);
      const currentIndex = targetHashes.indexOf(hash);
      if (currentIndex !== targetIndex) {
        patch.push({
          op: 'move',
          from: `${path}/${currentIndex}`,
          path: `${path}/${targetIndex}`,
        });
        // updates reference array
        moveArrayElement(targetHashes, currentIndex, targetIndex);
      }
    }
  }

  function compareArrays(leftArr: any[], rightArr: any[], path: string) {
    // if arrays are equal, no further comparison is required
    if (JSON.stringify(leftArr) === JSON.stringify(rightArr)) return;

    if (objectHash) {
      compareArrayByHash(leftArr, rightArr, path);
    } else {
      compareArrayByIndex(leftArr, rightArr, path);
    }
  }

  function compareObjects(
    path: string,
    leftJsonValue: any,
    rightJsonValue: any
  ) {
    const isArrayAtTop =
      path === '' && [leftJsonValue, rightJsonValue].every(Array.isArray);

    if (isPrimitiveValue(leftJsonValue) || isPrimitiveValue(rightJsonValue)) {
      if (leftJsonValue !== rightJsonValue) {
        patch.push({ op: 'replace', path: path, value: rightJsonValue });
      }
      return;
    }

    if (isArrayAtTop) {
      return compareArrays(leftJsonValue, rightJsonValue, '');
    }

    // if one of the current values is an array, we can't go deeper
    if ([leftJsonValue, rightJsonValue].some(Array.isArray)) {
      patch.push({ op: 'replace', path: path, value: rightJsonValue });
      return;
    }

    for (const rightKey in rightJsonValue) {
      if (
        hasPropertyFilter &&
        !propertyFilter(rightKey, { side: 'right', path })
      )
        continue;

      let newPath =
        isArrayAtTop && path === '' ? `/${rightKey}` : `${path}/${rightKey}`;
      const leftValue = leftJsonValue[rightKey];
      const rightValue = rightJsonValue[rightKey];

      if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
        compareArrays(leftValue, rightValue, newPath);
      } else if (isJsonObject(rightValue)) {
        if (isJsonObject(leftValue)) {
          compareObjects(newPath, leftValue, rightValue);
        } else if (leftJsonValue.hasOwnProperty(rightKey)) {
          patch.push({ op: 'replace', path: newPath, value: rightValue });
        } else {
          patch.push({ op: 'add', path: newPath, value: rightValue });
        }
      } else if (!leftJsonValue.hasOwnProperty(rightKey)) {
        patch.push({ op: 'add', path: newPath, value: rightValue });
      } else if (leftValue !== rightValue) {
        patch.push({ op: 'replace', path: newPath, value: rightValue });
      }
    }

    for (const leftKey in leftJsonValue) {
      if (
        !leftJsonValue.hasOwnProperty(leftKey) ||
        (hasPropertyFilter && !propertyFilter(leftKey, { side: 'left', path }))
      )
        continue;

      if (!rightJsonValue.hasOwnProperty(leftKey)) {
        let newPath =
          isArrayAtTop && path === '' ? `/${leftKey}` : `${path}/${leftKey}`;
        patch.push({ op: 'remove', path: newPath });
      }
    }
  }

  compareObjects('', before, after);

  return [...patch];
}

function isPrimitiveValue(value: JsonValue): value is JsonValue {
  return (
    value === undefined ||
    value === null ||
    typeof value === 'undefined' ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value?.constructor === Object;
}

function moveArrayElement(array: any[], from: number, to: number): void {
  array.splice(to, 0, array.splice(from, 1)[0]);
}

export type PathInfoResult = {
  segments: string[];
  length: number;
  last: string;
};

export function pathInfo(path: string): PathInfoResult {
  const segments = path.split('/');
  const length = segments.length;
  const last = segments[length - 1];
  return { segments, length, last };
}
