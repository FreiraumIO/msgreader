"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _utils = require("./utils");

var _const = _interopRequireDefault(require("./const"));

var _DataStream = _interopRequireDefault(require("./DataStream"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } }

function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); return Constructor; }

// MSG Reader implementation
// check MSG file header
function isMSGFile(ds) {
  ds.seek(0);
  return (0, _utils.arraysEqual)(_const.default.FILE_HEADER, ds.readInt8Array(_const.default.FILE_HEADER.length));
} // FAT utils


function getBlockOffsetAt(msgData, offset) {
  return (offset + 1) * msgData.bigBlockSize;
}

function getBlockAt(ds, msgData, offset) {
  var startOffset = getBlockOffsetAt(msgData, offset);
  ds.seek(startOffset);
  return ds.readInt32Array(msgData.bigBlockLength);
}

function getNextBlockInner(ds, msgData, offset, blockOffsetData) {
  var currentBlock = Math.floor(offset / msgData.bigBlockLength);
  var currentBlockIndex = offset % msgData.bigBlockLength;
  var startBlockOffset = blockOffsetData[currentBlock];
  return getBlockAt(ds, msgData, startBlockOffset)[currentBlockIndex];
}

function getNextBlock(ds, msgData, offset) {
  return getNextBlockInner(ds, msgData, offset, msgData.batData);
}

function getNextBlockSmall(ds, msgData, offset) {
  return getNextBlockInner(ds, msgData, offset, msgData.sbatData);
} // convert binary data to dictionary


function parseMsgData(ds) {
  var msgData = headerData(ds);
  msgData.batData = batData(ds, msgData);
  msgData.sbatData = sbatData(ds, msgData);

  if (msgData.xbatCount > 0) {
    xbatData(ds, msgData);
  }

  msgData.propertyData = propertyData(ds, msgData);
  msgData.fieldsData = fieldsData(ds, msgData);
  return msgData;
} // extract header data


function headerData(ds) {
  var headerData = {}; // system data

  headerData.bigBlockSize = ds.readByte(
  /*const position*/
  30) == _const.default.MSG.L_BIG_BLOCK_MARK ? _const.default.MSG.L_BIG_BLOCK_SIZE : _const.default.MSG.S_BIG_BLOCK_SIZE;
  headerData.bigBlockLength = headerData.bigBlockSize / 4;
  headerData.xBlockLength = headerData.bigBlockLength - 1; // header data

  headerData.batCount = ds.readInt(_const.default.MSG.HEADER.BAT_COUNT_OFFSET);
  headerData.propertyStart = ds.readInt(_const.default.MSG.HEADER.PROPERTY_START_OFFSET);
  headerData.sbatStart = ds.readInt(_const.default.MSG.HEADER.SBAT_START_OFFSET);
  headerData.sbatCount = ds.readInt(_const.default.MSG.HEADER.SBAT_COUNT_OFFSET);
  headerData.xbatStart = ds.readInt(_const.default.MSG.HEADER.XBAT_START_OFFSET);
  headerData.xbatCount = ds.readInt(_const.default.MSG.HEADER.XBAT_COUNT_OFFSET);
  return headerData;
}

function batCountInHeader(msgData) {
  var maxBatsInHeader = (_const.default.MSG.S_BIG_BLOCK_SIZE - _const.default.MSG.HEADER.BAT_START_OFFSET) / 4;
  return Math.min(msgData.batCount, maxBatsInHeader);
}

function batData(ds, msgData) {
  var result = new Array(batCountInHeader(msgData));
  ds.seek(_const.default.MSG.HEADER.BAT_START_OFFSET);

  for (var i = 0; i < result.length; i++) {
    result[i] = ds.readInt32();
  }

  return result;
}

function sbatData(ds, msgData) {
  var result = [];
  var startIndex = msgData.sbatStart;

  for (var i = 0; i < msgData.sbatCount && startIndex != _const.default.MSG.END_OF_CHAIN; i++) {
    result.push(startIndex);
    startIndex = getNextBlock(ds, msgData, startIndex);
  }

  return result;
}

function xbatData(ds, msgData) {
  var batCount = batCountInHeader(msgData);
  var batCountTotal = msgData.batCount;
  var remainingBlocks = batCountTotal - batCount;
  var nextBlockAt = msgData.xbatStart;

  for (var i = 0; i < msgData.xbatCount; i++) {
    var xBatBlock = getBlockAt(ds, msgData, nextBlockAt);
    nextBlockAt = xBatBlock[msgData.xBlockLength];
    var blocksToProcess = Math.min(remainingBlocks, msgData.xBlockLength);

    for (var j = 0; j < blocksToProcess; j++) {
      var blockStartAt = xBatBlock[j];

      if (blockStartAt == _const.default.MSG.UNUSED_BLOCK || blockStartAt == _const.default.MSG.END_OF_CHAIN) {
        break;
      }

      msgData.batData.push(blockStartAt);
    }

    remainingBlocks -= blocksToProcess;
  }
} // extract property data and property hierarchy


function propertyData(ds, msgData) {
  var props = [];
  var currentOffset = msgData.propertyStart;

  while (currentOffset != _const.default.MSG.END_OF_CHAIN) {
    convertBlockToProperties(ds, msgData, currentOffset, props);
    currentOffset = getNextBlock(ds, msgData, currentOffset);
  }

  createPropertyHierarchy(props,
  /*property with index 0 (zero) always as root*/
  props[0]);
  return props;
}

function convertName(ds, offset) {
  var nameLength = ds.readShort(offset + _const.default.MSG.PROP.NAME_SIZE_OFFSET);

  if (nameLength < 1) {
    return '';
  } else {
    return ds.readStringAt(offset, nameLength / 2);
  }
}

function convertProperty(ds, index, offset) {
  return {
    index: index,
    type: ds.readByte(offset + _const.default.MSG.PROP.TYPE_OFFSET),
    name: convertName(ds, offset),
    // hierarchy
    previousProperty: ds.readInt(offset + _const.default.MSG.PROP.PREVIOUS_PROPERTY_OFFSET),
    nextProperty: ds.readInt(offset + _const.default.MSG.PROP.NEXT_PROPERTY_OFFSET),
    childProperty: ds.readInt(offset + _const.default.MSG.PROP.CHILD_PROPERTY_OFFSET),
    // data offset
    startBlock: ds.readInt(offset + _const.default.MSG.PROP.START_BLOCK_OFFSET),
    sizeBlock: ds.readInt(offset + _const.default.MSG.PROP.SIZE_OFFSET)
  };
}

function convertBlockToProperties(ds, msgData, propertyBlockOffset, props) {
  var propertyCount = msgData.bigBlockSize / _const.default.MSG.PROP.PROPERTY_SIZE;
  var propertyOffset = getBlockOffsetAt(msgData, propertyBlockOffset);

  for (var i = 0; i < propertyCount; i++) {
    var propertyType = ds.readByte(propertyOffset + _const.default.MSG.PROP.TYPE_OFFSET);

    switch (propertyType) {
      case _const.default.MSG.PROP.TYPE_ENUM.ROOT:
      case _const.default.MSG.PROP.TYPE_ENUM.DIRECTORY:
      case _const.default.MSG.PROP.TYPE_ENUM.DOCUMENT:
        props.push(convertProperty(ds, props.length, propertyOffset));
        break;

      default:
        /* unknown property types */
        props.push(null);
    }

    propertyOffset += _const.default.MSG.PROP.PROPERTY_SIZE;
  }
}

function createPropertyHierarchy(props, nodeProperty) {
  if (nodeProperty.childProperty == _const.default.MSG.PROP.NO_INDEX) {
    return;
  }

  nodeProperty.children = [];
  var children = [nodeProperty.childProperty];

  while (children.length != 0) {
    var currentIndex = children.shift();
    var current = props[currentIndex];

    if (current == null) {
      continue;
    }

    nodeProperty.children.push(currentIndex);

    if (current.type == _const.default.MSG.PROP.TYPE_ENUM.DIRECTORY) {
      createPropertyHierarchy(props, current);
    }

    if (current.previousProperty != _const.default.MSG.PROP.NO_INDEX) {
      children.push(current.previousProperty);
    }

    if (current.nextProperty != _const.default.MSG.PROP.NO_INDEX) {
      children.push(current.nextProperty);
    }
  }
} // extract real fields


function fieldsData(ds, msgData) {
  var fields = {
    attachments: [],
    recipients: []
  };
  fieldsDataDir(ds, msgData, msgData.propertyData[0], fields);
  return fields;
}

function fieldsDataDir(ds, msgData, dirProperty, fields) {
  if (dirProperty.children && dirProperty.children.length > 0) {
    for (var i = 0; i < dirProperty.children.length; i++) {
      var childProperty = msgData.propertyData[dirProperty.children[i]];

      if (childProperty.type == _const.default.MSG.PROP.TYPE_ENUM.DIRECTORY) {
        fieldsDataDirInner(ds, msgData, childProperty, fields);
      } else if (childProperty.type == _const.default.MSG.PROP.TYPE_ENUM.DOCUMENT && childProperty.name.indexOf(_const.default.MSG.FIELD.PREFIX.DOCUMENT) == 0) {
        fieldsDataDocument(ds, msgData, childProperty, fields);
      }
    }
  }
}

function fieldsDataDirInner(ds, msgData, dirProperty, fields) {
  if (dirProperty.name.indexOf(_const.default.MSG.FIELD.PREFIX.ATTACHMENT) == 0) {
    // attachment
    var attachmentField = {};
    fields.attachments.push(attachmentField);
    fieldsDataDir(ds, msgData, dirProperty, attachmentField);
  } else if (dirProperty.name.indexOf(_const.default.MSG.FIELD.PREFIX.RECIPIENT) == 0) {
    // recipient
    var recipientField = {};
    fields.recipients.push(recipientField);
    fieldsDataDir(ds, msgData, dirProperty, recipientField);
  } else {
    // other dir
    var childFieldType = getFieldType(dirProperty);

    if (childFieldType != _const.default.MSG.FIELD.DIR_TYPE.INNER_MSG) {
      fieldsDataDir(ds, msgData, dirProperty, fields);
    } else {
      // MSG as attachment currently isn't supported
      fields.innerMsgContent = true;
    }
  }
}

function fieldsDataDocument(ds, msgData, documentProperty, fields) {
  var value = documentProperty.name.substring(12).toLowerCase();
  var fieldClass = value.substring(0, 4);
  var fieldType = value.substring(4, 8);
  var fieldName = _const.default.MSG.FIELD.NAME_MAPPING[fieldClass]; // makes sure to ignore duplicates of the body
  // that happen to be in binary

  if (fieldName && fieldName === "body") {
    if (!fields[fieldName] || _const.default.MSG.FIELD.TYPE_MAPPING[fieldType] !== "binary") {
      fields[fieldName] = getFieldValue(ds, msgData, documentProperty, fieldType);
    }
  } else if (fieldName && fieldName !== "body") {
    fields[fieldName] = getFieldValue(ds, msgData, documentProperty, fieldType);
  }

  if (fieldClass == _const.default.MSG.FIELD.CLASS_MAPPING.ATTACHMENT_DATA) {
    // attachment specific info
    fields['dataId'] = documentProperty.index;
    fields['contentLength'] = documentProperty.sizeBlock;
  }
}

function getFieldType(fieldProperty) {
  var value = fieldProperty.name.substring(12).toLowerCase();
  return value.substring(4, 8);
} // extractor structure to manage bat/sbat block types and different data types


var extractorFieldValue = {
  sbat: {
    'extractor': function extractDataViaSbat(ds, msgData, fieldProperty, dataTypeExtractor) {
      var chain = getChainByBlockSmall(ds, msgData, fieldProperty);

      if (chain.length == 1) {
        return readDataByBlockSmall(ds, msgData, fieldProperty.startBlock, fieldProperty.sizeBlock, dataTypeExtractor);
      } else if (chain.length > 1) {
        return readChainDataByBlockSmall(ds, msgData, fieldProperty, chain, dataTypeExtractor);
      }

      return null;
    },
    dataType: {
      'string': function extractBatString(ds, msgData, blockStartOffset, bigBlockOffset, blockSize) {
        ds.seek(blockStartOffset + bigBlockOffset);
        return ds.readString(blockSize);
      },
      'unicode': function extractBatUnicode(ds, msgData, blockStartOffset, bigBlockOffset, blockSize) {
        ds.seek(blockStartOffset + bigBlockOffset);
        return ds.readUCS2String(blockSize / 2);
      },
      'binary': function extractBatBinary(ds, msgData, blockStartOffset, bigBlockOffset, blockSize) {
        ds.seek(blockStartOffset + bigBlockOffset);
        var toReadLength = Math.min(Math.min(msgData.bigBlockSize - bigBlockOffset, blockSize), _const.default.MSG.SMALL_BLOCK_SIZE);
        return ds.readUint8Array(toReadLength);
      }
    }
  },
  bat: {
    'extractor': function extractDataViaBat(ds, msgData, fieldProperty, dataTypeExtractor) {
      var offset = getBlockOffsetAt(msgData, fieldProperty.startBlock);
      ds.seek(offset);
      return dataTypeExtractor(ds, fieldProperty);
    },
    dataType: {
      'string': function extractSbatString(ds, fieldProperty) {
        return ds.readString(fieldProperty.sizeBlock);
      },
      'unicode': function extractSbatUnicode(ds, fieldProperty) {
        return ds.readUCS2String(fieldProperty.sizeBlock / 2);
      },
      'binary': function extractSbatBinary(ds, fieldProperty) {
        return ds.readUint8Array(fieldProperty.sizeBlock);
      }
    }
  }
};

function readDataByBlockSmall(ds, msgData, startBlock, blockSize, dataTypeExtractor) {
  var byteOffset = startBlock * _const.default.MSG.SMALL_BLOCK_SIZE;
  var bigBlockNumber = Math.floor(byteOffset / msgData.bigBlockSize);
  var bigBlockOffset = byteOffset % msgData.bigBlockSize;
  var rootProp = msgData.propertyData[0];
  var nextBlock = rootProp.startBlock;

  for (var i = 0; i < bigBlockNumber; i++) {
    nextBlock = getNextBlock(ds, msgData, nextBlock);
  }

  var blockStartOffset = getBlockOffsetAt(msgData, nextBlock);
  return dataTypeExtractor(ds, msgData, blockStartOffset, bigBlockOffset, blockSize);
}

function readChainDataByBlockSmall(ds, msgData, fieldProperty, chain, dataTypeExtractor) {
  var resultData = new Int8Array(fieldProperty.sizeBlock);

  for (var i = 0, idx = 0; i < chain.length; i++) {
    var data = readDataByBlockSmall(ds, msgData, chain[i], _const.default.MSG.SMALL_BLOCK_SIZE, extractorFieldValue.sbat.dataType.binary);

    for (var j = 0; j < data.length; j++) {
      resultData[idx++] = data[j];
    }
  }

  var localDs = new _DataStream.default(resultData, 0, _DataStream.default.LITTLE_ENDIAN);
  return dataTypeExtractor(localDs, msgData, 0, 0, fieldProperty.sizeBlock);
}

function getChainByBlockSmall(ds, msgData, fieldProperty) {
  var blockChain = [];
  var nextBlockSmall = fieldProperty.startBlock;

  while (nextBlockSmall != _const.default.MSG.END_OF_CHAIN) {
    blockChain.push(nextBlockSmall);
    nextBlockSmall = getNextBlockSmall(ds, msgData, nextBlockSmall);
  }

  return blockChain;
}

function getFieldValue(ds, msgData, fieldProperty, type) {
  var value = null;
  var valueExtractor = fieldProperty.sizeBlock < _const.default.MSG.BIG_BLOCK_MIN_DOC_SIZE ? extractorFieldValue.sbat : extractorFieldValue.bat;
  var dataTypeExtractor = valueExtractor.dataType[_const.default.MSG.FIELD.TYPE_MAPPING[type]];

  if (dataTypeExtractor) {
    value = valueExtractor.extractor(ds, msgData, fieldProperty, dataTypeExtractor);
  }

  return value;
}

var MsgReader =
/*#__PURE__*/
function () {
  function MsgReader(arrayBuffer) {
    _classCallCheck(this, MsgReader);

    this.ds = new _DataStream.default(arrayBuffer, 0, _DataStream.default.LITTLE_ENDIAN);
  }

  _createClass(MsgReader, [{
    key: "getFileData",
    value: function getFileData() {
      if (!isMSGFile(this.ds)) {
        return {
          error: 'Unsupported file type!'
        };
      }

      if (this.fileData == null) {
        this.fileData = parseMsgData(this.ds);
      }

      return this.fileData.fieldsData;
    }
    /**
     Reads an attachment content by key/ID
       @return {Object} The attachment for specific attachment key
      */

  }, {
    key: "getAttachment",
    value: function getAttachment(attach) {
      var attachData = typeof attach === 'number' ? this.fileData.fieldsData.attachments[attach] : attach;
      var fieldProperty = this.fileData.propertyData[attachData.dataId];
      var fieldData = getFieldValue(this.ds, this.fileData, fieldProperty, getFieldType(fieldProperty));
      return {
        fileName: attachData.fileName,
        content: fieldData
      };
    }
  }]);

  return MsgReader;
}();

exports.default = MsgReader;