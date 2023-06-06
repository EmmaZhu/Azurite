const tagFilterOperators = [
  '=',
  '>=',
  '<=',
  '>',
  '<'
];

enum TransferState {
  Start,
  LeftEmbrace,
  Key,
  Operator,
  Value,
  AfterValue,
  RightEmbrace,
  Connector,
}

enum TokenType {
  TreeToken,
  TagComparingToken,
  ConnectorToken
}

interface Token {
  tokenType: TokenType;
}

type TagComparingToken = Token & {
  key?: string;
  operator?: string,
  value?: string,
}

type ConnectorToken = Token & {
  connector?: string;
}

type FilterTreeToken = Token & {
  token: Token[];
}

export function analysis(where: string): any {
  return TreeToFunction(
    Transform(where));
}

function convertOperator(input?: string): string {
  if (input === '=') {
    return '===';
  } else if (input === '>') {
    return '>';
  } else if (input === '<') {
    return '<';
  } else if (input === '>=') {
    return '>=';
  } else if (input === '<=') {
    return '<=';
  }

  throw new Error("Invalid operator");
}

function TagComparingToSentence(tagComparing: TagComparingToken): string {
  return `( tags.${tagComparing.key} !== undefined && tags.${tagComparing.key} ${convertOperator(tagComparing.operator)} ${tagComparing.value} )`;
}

function convertConnector(input?: ConnectorToken): string {
  if (input?.connector === 'and') {
    return ' && ';
  } else if (input?.connector === 'or') {
    return ' || ';
  }

  throw new Error("Invalid connector");
}

function TreeToSentence(tree: FilterTreeToken): string {
  const sentences = [];
  sentences.push("(");
  tree.token.forEach((aToken) => {
    if (aToken.tokenType === TokenType.TreeToken) {
      sentences.push(TreeToSentence(aToken as FilterTreeToken));
    }
    else if (aToken.tokenType === TokenType.TagComparingToken) {
      sentences.push(TagComparingToSentence(aToken as TagComparingToken));
    }
    else if (aToken.tokenType === TokenType.ConnectorToken) {
      sentences.push(convertConnector(aToken as ConnectorToken));
    }
  });
  sentences.push(")");
  return sentences.join("");
}

function TreeToFunction(tree: FilterTreeToken): Function {
  const judgement = TreeToSentence(tree);
  judgement;


  const functionRun = ["let tags = {}; ",
    "item.blobTags?.blobTagSet.forEach((aTag) => { ",
    " tags[aTag.key] = aTag.value; })",
    "",
    `return ${judgement};`].join("\n");
  console.log(functionRun);

  try {
    const functionReturned = new Function("item", functionRun);
    return functionReturned;
  }
  catch (err) {
    console.log(err);
    return new Function("item", "return true;");
  }
}

function Transform(where: string): FilterTreeToken {
  let pos = 0;
  let state: TransferState = TransferState.Start;
  let expectingRightEmbrace: number = 0;
  const tree: FilterTreeToken = {
    tokenType: TokenType.TreeToken,
    token: []
  };

  let treeStack: FilterTreeToken[] = [];
  let currentTree: FilterTreeToken = tree;
  let currentTagComparing: TagComparingToken = {
    tokenType: TokenType.TagComparingToken
  };

  while (pos < where.length) {
    switch (state) {
      case TransferState.Start:
        if (where[pos] === '(') {
          state = TransferState.LeftEmbrace;
          continue;
        } else {
          state = TransferState.Key;
          continue;
        }
      case TransferState.LeftEmbrace:
        expectingRightEmbrace++;
        const previousTree = currentTree;
        currentTree = {
          tokenType: TokenType.TreeToken,
          token: []
        };
        previousTree.token.push(currentTree);
        treeStack.push(previousTree);
        pos++;
        state = TransferState.Start;
        continue;
      case TransferState.Key:
        let keyPos = pos;
        for (; keyPos < where.length; ++keyPos) {
          if (where[keyPos] === '=' || where[keyPos] === '<' || where[keyPos] === '>') {
            break;
          }
        }
        currentTagComparing = {
          tokenType: TokenType.TagComparingToken,
          key: where.substring(pos, keyPos).trimEnd().trimStart()
        };
        currentTree.token.push(currentTagComparing);
        pos = keyPos;
        state = TransferState.Operator;
        // Validate key
        continue;
      case TransferState.Operator:
        let opPos = pos;
        for (; opPos < where.length; ++opPos) {
          if (where[opPos] === '\'') {
            break;
          }
        }
        currentTagComparing.operator = where.substring(pos, opPos).trimEnd().trimStart();
        if (!tagFilterOperators.includes(currentTagComparing.operator)) {
          throw new Error("Invalid operator");
        }
        // Validate operator
        pos = opPos;
        state = TransferState.Value;
        continue;
      case TransferState.Value:
        let valuePos = pos + 1;
        for (; valuePos < where.length; ++valuePos) {
          if (where[valuePos] === '\'') {
            break;
          }
        }
        currentTagComparing.value = where.substring(pos, valuePos + 1).trimEnd().trimStart();
        // Validate value
        pos = valuePos + 1;
        state = TransferState.AfterValue;
        continue;
      case TransferState.AfterValue:
        let afterPos = pos;
        for (; afterPos < where.length && where[afterPos] === ' '; ++afterPos);
        pos = afterPos;
        if (afterPos === where.length) {
          break;
        } else if (where[afterPos] === ')') {
          pos = afterPos;
          state = TransferState.RightEmbrace;
          continue;
        } else {
          pos = afterPos;
          state = TransferState.Connector;
          continue;
        }
      case TransferState.Connector:
        let connectorPos = pos;
        for (; connectorPos < where.length && where[connectorPos] !== ' '; ++connectorPos);
        currentTree.token.push({
          tokenType: TokenType.ConnectorToken,
          connector: where.substring(pos, connectorPos)
        } as ConnectorToken);
        for (pos = connectorPos; pos < where.length && where[pos] === ' '; ++pos);
        if (pos === where.length) throw new Error("Invalid filter");
        state = TransferState.Start;
        continue;
      case TransferState.RightEmbrace:
        expectingRightEmbrace--;
        currentTree = treeStack.pop() as FilterTreeToken;
        pos++;
        state = TransferState.AfterValue;
        continue;
    }
  }

  if (expectingRightEmbrace !== 0) {
    throw new Error("Expecting ')");
  }

  return tree;
}

// interface SegmentsWithoutEmbrace {
//   segments: (SegmentsWithoutEmbrace | string)[];
// }

// function isSegmentsWithoutEmbrace(input: unknown): input is SegmentsWithoutEmbrace {
//   if (!input || typeof input !== "object") {
//     return false;
//   }

//   const castValue = input as SegmentsWithoutEmbrace;

//   return Array.isArray(castValue.segments);
// }

// export function RemoveEmbrace(input: string, expectingEmbrace: boolean = false): SegmentsWithoutEmbrace {
//   const leftEmbrace = input.indexOf('(');
//   if (-1 === leftEmbrace) {
//     return {
//       segments: [
//         input
//       ]
//     };
//   }

//   if (expectingEmbrace) {
//     const rightEmbrace = input.indexOf(')');
//     if (rightEmbrace === -1) {
//       throw new Error("Expecting ')'");
//     }

//     if (rightEmbrace < leftEmbrace) {
//       return {
//         segments: [
//           input
//         ]
//       };
//     }
//   }

//   const segments: SegmentsWithoutEmbrace = {
//     segments: []
//   };

//   segments.segments.push(input.substring(0, leftEmbrace));

//   const result = RemoveEmbrace(input.substring(leftEmbrace + 1), true);
//   const lastOne = result.segments.pop();
//   if (isSegmentsWithoutEmbrace(lastOne)) {
//     throw new Error("Expecting ')'");
//   }

//   const rightEmbrace = lastOne!.indexOf(')');
//   if (-1 === rightEmbrace) {
//     throw new Error("Expecting ')'");
//   }

//   if (result.segments.length !== 0) {
//     segments.segments.push(result);
//   }
//   segments.segments.push(lastOne!.substring(0, rightEmbrace));
//   if (expectingEmbrace) {
//     segments.segments.push(lastOne!.substring(rightEmbrace + 1));
//   }
//   else {
//     segments.segments.push(RemoveEmbrace(lastOne!.substring(rightEmbrace + 1)));
//   }

//   return segments;
// }