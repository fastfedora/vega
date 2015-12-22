var d3 = require('d3'),
    Tuple = require('vega-dataflow/src/Tuple'),
    log = require('vega-logging'),
    Transform = require('./Transform'),
    BatchTransform = require('./BatchTransform');

/**
 * ### boxVoronoi
 *
 * Computes a box voronoi diagram for a set of input seed points and returns the computed rectangles.
 * A "box voronoi" is a variation of a traditional voronoi, where the voronoi algorithm is run on 
 * each dimension separately to return a set of rectangles instead of a set of irregular polygons. 
 *
 * The algorithm works by binning all items that share the same value in the first dimension together 
 * and creating rectangles for each of those, then splitting those rectangles using the items in each
 * bin by the value of the second dimension.
 *
 * Note: This transformation does not add output values that would fall outside the clipExtent, which
 * defaults to the screen extent.
 * 
 * | Property            | Type                | Description  |
 * | :------------------ |:-------------------:| :------------|
 * | x                   | Field               | The data field for seed point x-coordinates.|
 * | y                   | Field               | The data field for seed point y-coordinates.|
 * | bin                 | Value               | The first dimension to bin. Defaults to 'x', or 'y' if the 'x' field is not set.|
 * | clipExtent          | Array&lt;Array&lt;Number&gt;&gt; | An array containing the minimum and maximum coordinate for clipping the extreme edges of the voronoi diagram. For example, `[[-1e5, -1e5], [1e5, 1e5]]` will clip the voronoi diagram at 10,000 pixels in both the negative and positive directions.|
 * 
 * _Output_
 * 
 * The __boxVoronoi__ transform sets the following values on each datum:
 * 
 * | Name   | Default  Property | Description         |
 * | :-------------- | :------------- | :------------------ |
 * | x               | layout_x       | the left coordinate of the rectangle.|
 * | y               | layout_y       | the top coordinate of the rectangle.|
 * | width           | layout_width   | the width of the rectangle.|
 * | height          | layout_height  | the height of the rectangle.|
 * 
 * _Examples_
 * 
 * ```json
 * {"type": "boxVoronoi", "x": "layout_x", "y": "layout_y"}
 * ```
 * Adds Voronoi rectangle information based on previously computed layout coordinates.
 * 
 * ```json
 * {"type": "boxVoronoi", "x": "layout_x"}
 * ```
 * Adds Voronoi rectangle information for only a single dimension based on previously computed layout coordinates.
 */
function BoxVoronoi(graph) {
  BatchTransform.prototype.init.call(this, graph);
  Transform.addParameters(this, {
    clipExtent: {type: 'array<value>', default: require('./screen').extent},
    bin: {type: 'value', default: null},
    x: {type: 'field', default: null},
    y: {type: 'field', default: null}
  });

  this._layout = d3.geom.voronoi();
  this._output = {
    'x':      'layout_x',
    'y':      'layout_y',
    'width':  'layout_width',
    'height': 'layout_height',
  };

  return this.mutates(true);
}

var prototype = (BoxVoronoi.prototype = Object.create(BatchTransform.prototype));
prototype.constructor = BoxVoronoi;

prototype.batchTransform = function(input, data) {
  log.debug(input, ['voronoi']);

  var output      = this._output,
      clipExtent  = this.param('clipExtent'),
      binField    = this.param('bin') != null ? this.param('bin') : (this.param('x').field != null ? 'x' : 'y'),
      xInfo       = {
                        param:    this.param('x'),
                        location: output.x,
                        size:     output.width,
                        extent:   [ clipExtent[0][0], clipExtent[1][0] ]
                    },
      yInfo       = {
                        param:    this.param('y'),
                        location: output.y,
                        size:     output.height,
                        extent:   [ clipExtent[0][1], clipExtent[1][1] ]
                    },
      binInfo     = binField === 'x' ? xInfo : yInfo,
      splitInfo   = binField === 'x' ? yInfo : xInfo;

  // compute spans on the bin dimension
  var bins = layout(data, binInfo.param.accessor, binInfo.extent, binInfo.location, binInfo.size);

  // compute spans on the split dimension, if set
  if (splitInfo.param.field != null) {
    bins.forEach(function(key, items) {
      layout(items, splitInfo.param.accessor, splitInfo.extent, splitInfo.location, splitInfo.size);
    });
  }
  // otherwise make every element span the entire bin
  else {
    bins.forEach(function(key, items) {
      items.forEach(function(n) {
        Tuple.set(n, splitInfo.location, splitInfo.extent[0]);
        Tuple.set(n, splitInfo.size, splitInfo.extent[1] - splitInfo.extent[0]);
      });
    });      
  }

  // return changeset
  input.fields[binInfo.location]   = 1;
  input.fields[binInfo.size]       = 1;
  input.fields[splitInfo.location] = 1;
  input.fields[splitInfo.size]     = 1;
  
  return input;
};

/**
 * Create a span that indicates the nearest datum along a line.
 * 
 * A span is created for each datum in `data` that starts halfway from the
 * previous datum and extends to halfway to the next datum, based on the value
 * of each datum as determined by calling the `accessor` function with the
 * datum. The span for the first datum starts at the value of the first element
 * in the `extent` array and the span for the last element stops at the value 
 * of the last element in the `extent` array.
 *
 * The start of the span is set on the datum under the `locationField` and the
 * size of the span is set under the `sizeField`.
 *
 * Note: This produces the same results as running a Voronoi algorithm on the 
 * points of a line rather than a plane.
 */
function layout(data, accessor, extent, locationField, sizeField) {
  var bins     = d3.map(),
      keys     = [],
      binBoxes = {},
      filtered = [];

  // bin data
  for (var i=0; i<data.length; ++i) {
    var key = accessor(data[i]);
    if (key >= extent[0] && key <= extent[1]) {
      if (!bins.has(key)) {
        bins.set(key, []);
        keys.push(key);
      }
      bins.get(key).push(data[i]);
    }
    else {
      filtered.push(data[i]);
    }
  }

  // add fields for each bin
  keys.sort(d3.ascending);

  for (var i=0; i<keys.length; i++) {
    var start = i == 0 ? extent[0] : keys[i-1] + (keys[i] - keys[i-1]) / 2,
        end   = i == keys.length - 1 ? extent[1] : keys[i] + (keys[i+1] - keys[i]) / 2;

    bins.get(keys[i]).forEach(function(n) {
      Tuple.set(n, locationField, start);
      Tuple.set(n, sizeField, end - start > 0 ? end - start : start - end);
    });
  }

  // remove any data for filtered fields
  filtered.forEach(function(n) {
    Tuple.set(n, locationField, undefined);
    Tuple.set(n, sizeField, undefined);
  });

  return bins;
}

module.exports = BoxVoronoi;

BoxVoronoi.schema = {
  "$schema": "http://json-schema.org/draft-04/schema#",
  "title": "Box Voronoi transform",
  "type": "object",
  "properties": {
    "type": {"enum": ["boxVoronoi"]},
    "clipExtent": {
      "description": "The min and max points at which to clip the voronoi diagram.",
      "oneOf": [
        {
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "array",
                "items": {"oneOf": [{"type": "number"}, {"$ref": "#/refs/signal"}]},
                "minItems": 2,
                "maxItems": 2
              },
              {"$ref": "#/refs/signal"}
            ]
          },
          "minItems": 2,
          "maxItems": 2
        },
        {"$ref": "#/refs/signal"}
      ],
      "default": [[-1e5,-1e5],[1e5,1e5]]
    },
    "x": {
      "description": "The input x coordinates.",
      "oneOf": [{"type": "string"}, {"$ref": "#/refs/signal"}]
    },
    "y": {
      "description": "The input y coordinates.",
      "oneOf": [{"type": "string"}, {"$ref": "#/refs/signal"}]
    },
    "bin": {
      "description": "The first dimension to bin.",
      "oneOf": [{"enum": ["x", "y"]}, {"$ref": "#/refs/signal"}]
    },
    "output": {
      "type": "object",
      "description": "Rename the output data fields",
      "properties": {
        "x": {"type": "string", "default": "layout_x"},
        "y": {"type": "string", "default": "layout_y"},
        "width": {"type": "string", "default": "layout_width"},
        "height": {"type": "string", "default": "layout_height"}
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false,
  "required": ["type"]
};
