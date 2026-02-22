const fs = require('fs');
const path = require('path');
const dbPath = process.env.AGENFK_DB_PATH || path.join(process.cwd(), '.agenfk', 'db.json');

function deduplicate() {
    if (!fs.existsSync(dbPath)) {
        console.error(`Database not found at ${dbPath}`);
        return;
    }
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    
    db.items.forEach(item => {
        if (item.tokenUsage && item.tokenUsage.length > 1) {
            // Very simple deduplication: if multiple identical entries exist, keep only one
            const unique = [];
            const seen = new Set();
            item.tokenUsage.forEach(usage => {
                const key = `${usage.input}-${usage.output}-${usage.model}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    unique.push(usage);
                }
            });
            item.tokenUsage = unique;
        }
    });

    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    console.log("Deduplicated token usage.");
}

deduplicate();
