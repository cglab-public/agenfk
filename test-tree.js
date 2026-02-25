const items = [
  { id: '1', parentId: null, tokenUsage: [{input: 10, output: 10}] },
  { id: '2', parentId: '1', tokenUsage: [{input: 20, output: 20}] },
  { id: '3', parentId: null, tokenUsage: [{input: 30, output: 30}] }
];

const navPath = []; // Top level

const getSubtreeItems = (items, parentIds) => {
  if (!parentIds || parentIds.length === 0) return items;
  const currentParentId = parentIds[parentIds.length - 1].id;
  
  // Find all descendants of currentParentId
  const descendants = [];
  const findDescendants = (parentId) => {
    const children = items.filter(i => i.parentId === parentId);
    for (const child of children) {
      descendants.push(child);
      findDescendants(child.id);
    }
  };
  
  // Include the parent itself or just descendants?
  // Usually if we are drilled down, we want the parent and its descendants.
  // Wait, if we drill down, we see the children on the board. So we want the descendants.
  findDescendants(currentParentId);
  return descendants;
};

console.log(getSubtreeItems(items, navPath).length);
console.log(getSubtreeItems(items, [{id: '1'}]).length);
