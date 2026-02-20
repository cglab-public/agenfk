"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ItemType = exports.Status = void 0;
var Status;
(function (Status) {
    Status["TODO"] = "TODO";
    Status["IN_PROGRESS"] = "IN_PROGRESS";
    Status["REVIEW"] = "REVIEW";
    Status["DONE"] = "DONE";
    Status["BLOCKED"] = "BLOCKED";
})(Status || (exports.Status = Status = {}));
var ItemType;
(function (ItemType) {
    ItemType["EPIC"] = "EPIC";
    ItemType["STORY"] = "STORY";
    ItemType["TASK"] = "TASK";
    ItemType["BUG"] = "BUG";
})(ItemType || (exports.ItemType = ItemType = {}));
