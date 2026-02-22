const fs = require('fs');
const path = require('path');

const rootDir = process.cwd();
const db1Path = path.join(rootDir, '.agenfk', 'db.json');
const db2Path = path.join(rootDir, 'agentic-framework', '.agenfk', 'db.json');
const targetPath = db2Path;

function merge() {
    const db1 = JSON.parse(fs.readFileSync(db1Path, 'utf8'));
    const db2 = JSON.parse(fs.readFileSync(db2Path, 'utf8'));

    const itemsMap = new Map();
    db1.items.forEach(item => itemsMap.set(item.id, item));
    db2.items.forEach(item => itemsMap.set(item.id, item));

    const merged = {
        items: Array.from(itemsMap.values())
    };

    fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2));
    console.log(`Merged ${merged.items.length} items into ${targetPath}`);
    
    // Remove the old one
    fs.unlinkSync(db1Path);
    console.log(`Removed ${db1Path}`);
}

merge();
