#!/usr/bin/env node

'use strict'; // eslint-disable-line
const program = require('commander');
const path = require('path');
const babylon = require('babylon');
const { readFileSync, writeFileSync } = require('fs');
const _ = require('lodash');
const tree = require('pretty-tree');
const globby = require('globby');

program
  .version('1.1.1')
  .usage('[opts] <path/to/rootComponent>')
  // .option('-a, --aliasing  <config>', 'Path to Webpack config for getting module alias definitions')
  .option('-c, --hide-containers', 'Hide redux container components')
  .option('-d, --scan-depth <depth>', 'Limit the depth of the component hierarchy that is displayed', parseInt, Number.POSITIVE_INFINITY)
  .option('-j, --json', 'Output graph to JSON file instead of printing it on screen')
  .option('-m, --module-dir <dir>', 'Path to additional modules not included in node_modules e.g. src')
  .option('-t, --hide-third-party', 'Hide third party components')
  // .option('-p, --page', 'Parsing a mock page')
  .option('-o, --output <output>', 'Path to output json')
  .description('React component hierarchy viewer.')
  .parse(process.argv);

if (!program.args[0]) {
  program.help();
}

// const webpackConfigPath = program.aliasing;
const hideContainers = program.hideContainers;
const scanDepth = Math.max(program.scanDepth,1);
const outputJSON = program.json;
// const parsingPage = typeof program.page !== 'undefined';
const moduleDir = program.moduleDir;
const hideThirdParty = program.hideThirdParty;
const outputPath = program.output || 'data.json';

// use globby and extract the targets
// const filenames = path.resolve(program.args[0]);

// console.info('parsingPage', parsingPage);

const getRelativePath = (value) => {
  return value.replace(process.cwd() + '/', '');
}

// our mappings
const componentToMocks = {};
const componentToComponents = {};

// And so it begins...
// const pageId = program.args[0];
// mockToComponents[pageId] = [];

function extractModules(bodyItem) {
  if (
    bodyItem.type === 'ImportDeclaration' &&
    !bodyItem.source.value.endsWith('css')
  ) {
    // There may be more than one import in the declaration
    return bodyItem.specifiers.map(specifier => ({
      name: specifier.local.name,
      // change the source appropriately
      source: bodyItem.source.value,
    }));
  }
  return null;
}

function extractChildComponents(tokens, imports) {
  const childComponents = [ ...imports ].filter((v) => {
    // now we need to scan relative paths...
    // TODO: pass these filters in as a flag
    return v.source.includes('components/') || v.source.includes('containers/') || v.source.includes('..');
  });

  let childComponent;
  // console.info('imports', imports);

  // need to map something based off styled components
  // for (var i = 0; i < tokens.length - 1; i++) {
  //   if (
  //     tokens[i].type.label === 'jsxTagStart' &&
  //     tokens[i + 1].type.label === 'jsxName'
  //   ) {
  //     childComponent = _.find(imports, { name: tokens[i + 1].value });
  //     if (childComponent) {
  //       childComponents.push(childComponent);
  //     }
  //   } else if (
  //     tokens[i].type.label === 'jsxName' &&
  //     tokens[i].value === 'component'
  //   ) {
  //     // Find use of components in react-router, e.g. `<Route component={...}>`
  //     childComponent = _.find(imports, { name: tokens[i + 3].value });
  //     if (childComponent) {
  //       childComponents.push(childComponent);
  //     }
  //   }
  // }
  return childComponents;
}

function formatChild(child, parent, depth) {
  let fileName;
  let source;

  if (child.source.startsWith('.')) {
    // Relative import (./ or ../)
    fileName = path.resolve(path.dirname(parent.filename) + '/' + child.source);
    // TODO: pass process.cwd() value in as a flag
    source = fileName.replace(process.cwd() + '/', '');
  } else {
    // TODO: pass process.cwd() in as a flag
    fileName = path.join(process.cwd(), 'src', child.source);
    // console.info('fileName', fileName);
    source = child.source;
  }
  return {
    source,
    name: child.name,
    filename: fileName,
    children: [],
    depth,
  };
}

function extractExport(body) {
  let result;
  body.some(b => {
    if (b.type === 'ExportDefaultDeclaration') {
      result = b.declaration.name;
    }
    return result;
  });
  return result;
}

function findImportInArguments(func, imports, importNames) {
  const args = _.get(func, '.arguments', []).map(a => a.name);
  const foundImports = _.intersection(args, importNames);
  return _.get(foundImports, '[0]');
}

function findImportInExportDeclaration(body, exportIdentifier, imports) {
  let result;
  const importNames = imports.map(i => i.name);
  body.some(b => {
    if (
      b.type === 'VariableDeclaration' &&
      b.declarations[0].id.name === exportIdentifier &&
      b.declarations[0].init.type === 'CallExpression'
    ) {
      // If the export is being declared with the result of a function..
      // Try to find a reference to any of the imports either in the function arguments,
      // or in the arguments of any other functions being called after this function
      let func = b.declarations[0].init;
      while (!result && func) {
        result = findImportInArguments(func, imports, importNames);
        if (!result) {
          func = _.get(func, '.callee');
        }
      }
      if (result) {
        result = _.find(imports, { name: result });
      }
    }
    return result;
  });
  return result;
}

// - Find out what is being exported
// - Look for the export variable declaration
// - Look for any imported identifiers being used as a function parameter
// - Return that as the child
function findContainerChild(node, body, imports, depth) {
  const exportIdentifier = extractExport(body);
  const usedImport = findImportInExportDeclaration(
    body,
    exportIdentifier,
    imports
  );
  return (usedImport && [formatChild(usedImport, node, depth)]) || [];
}

function processFile(node, file, depth, parent, parentIds, pageId) {
  // console.info('parentIds', parentIds);
  // console.info('node.filename', node.filename);
  // console.info('processFile', node);
  const ast = babylon.parse(file, {
    sourceType: 'module',
    plugins: [
      'asyncGenerators',
      'classProperties',
      'decorators',
      'dynamicImport',
      'exportExtensions',
      'flow',
      'functionBind',
      'functionSent',
      'jsx',
      'objectRestSpread',
    ],
  });

  // Get a list of imports and try to figure out which are child components
  let imports = [];

  for (const i of ast.program.body.map(extractModules)) {
    if (!!i) {
      imports = imports.concat(i);
    }
  }

  const relativeFileName = getRelativePath(node.filename);
  if (!componentToMocks[relativeFileName]) {
    componentToMocks[relativeFileName] = new Set();
  }
  componentToMocks[relativeFileName].add(pageId);

  if (_.find(imports, { name: 'React' })) {
    // Look for children in the JSX
    const childComponents = _.uniq(extractChildComponents(ast.tokens, imports));
    // console.info('childComponents', childComponents);

    // console.info('node.source', node.source);

    // if node.source is undefined it means we're at the top level
    node.children = childComponents.map(c => formatChild(c, node, depth));
    // console.info('node.children', node.children);

    // add these children to each thing in the parentIds array
    for (const parentId of parentIds) {
      if (!componentToComponents[parentId]) {
        componentToComponents[parentId] = new Set();
      }
      // const childIdsToAdd = node.children.map(c => c.filename);
      // // console.info('parentId', parentId);
      // // console.info('childIdsToAdd', childIdsToAdd);
      // console.info('parentId', parentId);
      // console.info('adding', childIdsToAdd.length);
      componentToComponents[parentId].add(getRelativePath(node.filename));
    }
  } else {
    // Not JSX.. try to search for a wrapped component
    node.children = findContainerChild(node, ast.program.body, imports, depth);
    // add these children to each thing in the parentIds array
    for (const parentId of parentIds) {
      if (!componentToComponents[parentId]) {
        componentToComponents[parentId] = new Set();
      }
      // const childIdsToAdd = node.children.map(c => c.filename);
      // console.info('parentId', parentId);
      // console.info('adding', childIdsToAdd.length);
      componentToComponents[parentId].add(getRelativePath(node.filename));
    }
    // console.info('node.children', node.children);
  }
}

function formatNodeToPrettyTree(node) {
  if (hideContainers && node.name.indexOf('Container') > -1) {
    node.children[0].name += ' (*)';
    return formatNodeToPrettyTree(node.children[0]);
  }

  // If we have the source, format it nicely like `module/Component`
  // But only if the name won't be repeated like `module/Component/Component`
  const source =
    path.basename(path.dirname(node.filename)) === node.name
      ? node.source
      : node.source + '/' + node.name;
  const newNode =
    node.children.length > 0
      ? {
          label: (node.source && source) || node.name,
          nodes: node.children
            .filter(n => !n.hide)
            .sort((a, b) => {
              // Sort the list by source and name for readability
              const nameA = (a.source + a.name).toUpperCase();
              const nameB = (b.source + b.name).toUpperCase();

              if (nameA < nameB) {
                return -1;
              }
              if (nameA > nameB) {
                return 1;
              }

              return 0;
            })
            .map(formatNodeToPrettyTree),
          depth: node.depth,
        }
      : {
          label: source,
          depth: node.depth,
        };

  return newNode;
}

function done() {
  // if (!rootNode.children) {
  //   console.error(
  //     'Could not find any components. Did you process the right file?'
  //   );
  //   process.exit(1);
  // }

  Object.keys(componentToComponents).forEach(k => {
    componentToComponents[k] = Array.from(componentToComponents[k]);
  });
  // console.info('componentToComponents', componentToComponents);

  // if (parsingPage) {
  Object.keys(componentToMocks).forEach(k => {
    componentToMocks[k] = Array.from(componentToMocks[k]);
  });
  // console.info('componentToMocks', componentToMocks);
  // }
  // time to write the data to a file...
  if (outputJSON) {
    const writeToPath = path.join(process.cwd(), outputPath);
    // console.info('writing json to outputPath', outputPath);
    writeFileSync(writeToPath,
      JSON.stringify({
        componentToComponents,
        componentToMocks,
      }, null, '  ')
    );
  } else {
    // console.log(tree(formatNodeToPrettyTree(rootNode)));
  }
  process.exit();
}

// Get a list of names to try to resolve
function getPossibleNames(baseName) {
  return [
    baseName,
    baseName.replace('.js', '.jsx'),
    baseName.replace('.js', '/index.js'),
    baseName.replace('.js', '/index.jsx'),
  ];
}

function processNode(node, depth, parent, parentIds, pageId) {
  const newParentIds = [ ...parentIds ];
  if (typeof parent !== 'undefined' && parent) {
    newParentIds.push(getRelativePath(parent.filename));
  }

  const fileExt = path.extname(node.filename);
  if (fileExt === '') {
    // It's likely users will reference files that do not have an extension, try .js and then .jsx
    node.filename = `${node.filename}.js`;
  }

  let possibleFiles = getPossibleNames(node.filename);

  if (parent && moduleDir) {
    const baseName = node.filename.replace(
      path.dirname(parent.filename),
      moduleDir
    );
    possibleFiles = possibleFiles.concat(getPossibleNames(baseName));
  }

  // console.info('possibleFiles', possibleFiles);
  for (const name of possibleFiles) {
    node.filename = name;
    try {
      const file = readFileSync(node.filename, 'utf8');
      if(depth <= scanDepth){
        processFile(node, file, depth, parent, newParentIds, pageId);
      }

      node.children.forEach(c => processNode(c, depth + 1, node, newParentIds, pageId));
      return;
    } catch (e) {
      // console.info('e', e.stack);
    }
  }

  if (hideThirdParty) {
    node.hide = true;
  }
}

// do this for many...
console.info('program.args[0]', program.args[0]);
const filenames = globby.sync(program.args[0]);
// console.info('filenames', filenames);
// put in a loop
const promises = [];
console.info('filenames.length', filenames.length);
for (const filename of filenames) {
  const promise = new Promise(resolve => {
    console.info('loop', filename);
    const rootNode = {
      name: path.basename(filename).replace(/\.jsx?/, ''),
      filename,
      depth: 0,
      children: [],
    };
    processNode(rootNode, 1, null, [], filename);
    console.info('resolved', filename);
    resolve();
  });

  promises.push(promise);
}

return Promise.all(promises).then(done);