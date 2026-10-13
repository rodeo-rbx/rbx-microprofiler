/*
 * LibMP web tools and adapter for the MicroProfiler HTML viewer.
 *
 * Browser mode exposes the ASCII GPRX in the document's first comment through
 * ranged reads. Node mode reads the configured .gprx/.x.html input, and direct
 * execution exposes the conversion, framegraph, combination, and comparison tools.
 * CLI (keep libmp.js and viewer.js beside this file):
 *   node tools.js --help
 *   node tools.js --convert capture.gprx [capture.x.html]
 */
(function (root, factory) {
    const api = factory(root);
    root.LibMPTools = api;
    root.InitDataImpl = api.InitDataImpl;
    if (typeof module !== "undefined" && module.exports)
        module.exports = api;
})(globalThis, function (root) {
    "use strict";

    const LOG_LEAVE = 0;
    const LOG_ENTER = 1;
    const LOG_META = 2;
    const LOG_LABEL = 3;
    const LOG_GPU_EXTRA = 4;
    const LOG_LABEL_LITERAL = 5;
    const LOG_EVENT = 6;
    const EVENT_BASE = 128;
    const EVENT_MEM_SCOPE_STATS = 20;
    const EVENT_SPAN_BEGIN = 29;
    const EVENT_SPAN_END = 30;
    const EVENT_CPU_CORE_AND_FREQUENCY = 37;
    const TICK_MASK = 0x0000ffffffffffffn;
    const EVENT_DATA_MASK = 0x0003ffffffffffffn;
    const EVENT_DEPENDENT_DATA_MASK = 0xffffffffffn;
    const TICK_RANGE = 1n << 48n;
    const TICK_SIGN = 1n << 47n;
    const HTML_COMMENT_CLOSE = new TextEncoder().encode("-->");
    const MAGIC_PART_SIZE = 4;
    const MAX_GROUPS = 48;
    const BYTES_PER_MEBIBYTE = 1024 * 1024;
    const LABEL_PLACEHOLDER = "<unresolved_label>";
    const FRAMEGRAPH_EXPORT_CPU = "ExportFramegraphCpu";
    const FRAMEGRAPH_EXPORT_MEM = "ExportFramegraphMem";
    const FRAMEGRAPH_EXPORT_COMBO_DIFF = "ExportFramegraphComboDiff";
    const STANDALONE_EXPORT = "ExportStandaloneHtml";
    // Controls whether standalone export is shown in the viewer.
    const ENABLE_STANDALONE_EXPORT = false;
    const STANDALONE_ASSET_NAMES = ["libmp.js", "tools.js", "viewer.js"];
    const FRAMEGRAPH_DETAIL_THRESHOLD = 0.005;
    // Adapted from Client/Tools/mptools/app/framegraph.html.template.
    const FRAMEGRAPH_HTML_TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap.min.css">
<link rel="stylesheet" type="text/css" href="https://cdn.jsdelivr.net/npm/d3-flame-graph@4.1.3/dist/d3-flamegraph.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/nouislider@15.8.1/dist/nouislider.min.css">

<style>
/* Space out content a bit */
body {
    padding-top: 20px;
    padding-bottom: 20px;
}

/* Custom page header */
.header {
    padding-bottom: 20px;
    padding-right: 15px;
    padding-left: 15px;
    border-bottom: 1px solid #e5e5e5;
}

/* Make the masthead heading the same height as the navigation */
.header h3 {
    margin-top: 0;
    margin-bottom: 0;
    line-height: 32px;
}

/* Customize container */
.container {
    width: 95vw;
    max-width: 95vw;
    box-sizing: border-box;
}

#chart {
    width: 100%;
    overflow: hidden;
}

#chart svg {
    max-width: 100%;
    display: block;
}

.c-1-color {
    background: #d2d2d2;
}
</style>

<title>MicroProfiler Flamegraph</title>
</head>
<body>
<div id="Spinner" style="width:100%; text-align:center; display:block;">Loading...</div>
<div class="container" id="MainView" style="display:none;">
    <div class="header clearfix">
    <nav>
        <div class="pull-right">
        <form class="form-inline" id="form">
            <a id="TopDownButton" class="btn" style="display:none; vertical-align: top;" href="javascript: topDownToggle();">Top down</a>
            <a class="btn" style="vertical-align: top;" href="javascript: resetZoom();">Reset zoom</a>
            <a class="btn" style="vertical-align: top;" href="javascript: clear();">Clear</a>
            <div class="form-group">
            <input type="text" class="form-control" id="term">
            <br>
            <select id="GraphSelector" style="display:none; width: 100%; height: 32px;" onchange="OnSelectGraph();">
            </select>
            <br>
            <select id="SensModeSelector" style="display:none; width: 100%; height: 32px;" onchange="OnSelectSensMode();">
            </select>
            </div>
            <a class="btn btn-primary" style="vertical-align: top;" href="javascript: search();">Search</a>
        </form>
        </div>
    </nav>
    <h3 id="PlaceId" class="text-muted">MicroProfiler Flamegraph Place ID =</h3>
    <h4 id="DumpsInfo"></h4>
    <h5 id="CollectionTime" class="text-muted">Collection time: </h5>
    <h5 id="CollectionTimeAge" class="text-muted"> ago</h5>
    </div>
    <div id="sliderContainer" style="display:none;">
    </div>
    <div id="chart">
    </div>
    <hr>
    <div id="details-hidden" style="display:none;">
    </div>
    <div id="details">
    </div>
</div>

<!-- D3.js -->
<script src="https://d3js.org/d3.v7.js" charset="utf-8"></script>

<!-- d3-tip -->
<script type="text/javascript" src="https://cdnjs.cloudflare.com/ajax/libs/d3-tip/0.9.1/d3-tip.min.js"></script>

<!-- d3-flamegraph -->
<script type="text/javascript" src="https://cdn.jsdelivr.net/npm/d3-flame-graph@4.1.3/dist/d3-flamegraph.min.js"></script>

<!-- slider -->
<script src="https://cdn.jsdelivr.net/npm/nouislider@15.8.1/dist/nouislider.min.js"></script>

<script type="text/javascript">
if (globalThis.g_cliMode) {
    globalThis.window = globalThis;
    globalThis.document = {
        childNodes: [],
        getElementById: function(x) { return {}; },
        createElement: function(x) { return {}; },
    };
    globalThis.navigator = {
        platform: "",
    };
    if (!window.location) {
        window.location = {
            hash: "",
            pathname: "",
        };
    }
}

// Constants
const normalizedNumberOfFrames = 1;
const defaultSensitivity0 = 5;
const defaultSensitivity1 = 70;
const mismatchColor = "#d2d2d2ff"; // Alpha serves as a mismatch marker

// Enums
const ViewModes = {
    Default: 0,
    Combo: 1,
    Diff: 2,
};

// Context
var containers_json = [];
var selected_container = {};
var selected_graph = {};

var viewMode = 0;
var containerId = 0;
var topDown = true;

var sensitivity0 = defaultSensitivity0;
var sensitivity1 = defaultSensitivity1;

var searchStr = "";

// Temp. data
var hash2node = [];

// Elements
var flameGraph = null;

var collectionTime = document.getElementById('CollectionTime');
var collectionTimeAgo = document.getElementById('CollectionTimeAge');
var placeIdTitle = document.getElementById('PlaceId');
var dumpsInfo = document.getElementById('DumpsInfo');

var detailsHidden = document.getElementById("details-hidden");
var details = document.getElementById("details");

///////////////////////////////////////////////////////////////////////////
//%DATA%

///////////////////////////////////////////////////////////////////////////
function GetSensitivityCoefs() {
    var res = {};

    var combo = document.getElementById('SensModeSelector');
    res.isAbs = (combo.selectedIndex > 0);
    var format = GetSelectedUnitsFormat();

    const coefBase = res.isAbs ? format.sensAbsMax : 1.0;
    const uiMin = sensitivity0 / 100;
    const uiMax = sensitivity1 / 100;
    res.max = coefBase * uiMax;
    res.min = coefBase * uiMin;

    return res;
}

function ClearDetailsLabel() {
    details.innerHTML = '';
}

function UpdateSliderLabel() {
    var label = 'Sensitivity adjustment, ';
    var format = GetSelectedUnitsFormat();
    var coefs = GetSensitivityCoefs();
    if (coefs.isAbs) {
        label += d3.format(format.total)(coefs.min) + ' &mdash; ' + d3.format(format.total)(coefs.max) + ' ' + format.units;
    } else {
        label += sensitivity0 + ' &mdash; ' + sensitivity1 + '%';
    }
    details.innerHTML = label;
}

function InitSlider(callback) {
    function OnSliderUpdate(values, handle, callback) {
        if (handle === 0) {
            sensitivity0 = values[0];
        } else if (handle === 1) {
            sensitivity1 = values[1];
        }
        UpdateSliderLabel();
        if (callback) {
            callback();
        }
    }

    var sliderContainer = document.getElementById('sliderContainer');
    sliderContainer.style.display = "";

    var format = {
        to: function(value) {
            return Math.round(value);
        },
        from: function (value) {
            return Math.round(value);
        }
    };

    noUiSlider.create(sliderContainer, {
        start: [defaultSensitivity0, defaultSensitivity1], // Initial positions of the handles
        connect: true, // Display a colored bar between the handles
        step: 1,
        margin: 5,
        tooltips: false,
        format: format,
        range: {
            'min': 0,
            'max': 100
        }
    });

    // Display initial values in the input fields
    sliderContainer.noUiSlider.on('change', (values, handle) => { OnSliderUpdate(values, handle, callback); });
    sliderContainer.noUiSlider.on('update', (values, handle) => { OnSliderUpdate(values, handle); });

    var connect = sliderContainer.querySelectorAll('.noUi-connect');
    var classes = ['c-1-color'];
    for (var i = 0; i < connect.length; i++) {
        connect[i].classList.add(classes[i]);
    }

    sliderContainer.addEventListener('mouseenter', function(event) {
        UpdateSliderLabel();
    });
    sliderContainer.addEventListener('mouseleave', function(event) {
        ClearDetailsLabel();
    });

    ClearDetailsLabel();
}

function GetFlameGraphWidth() {
    var chart = document.getElementById("chart");
    var width = chart ? chart.getBoundingClientRect().width : 0;
    if (!width) {
        width = window.innerWidth * 0.95 - 30;
    }
    return Math.max(1, Math.floor(width));
}

function ResizeFlameGraph() {
    if (!flameGraph || !selected_graph) {
        return;
    }
    SetFlameGraphData();
}

function InitFlameGraph() {
    var flameGraphTip = (() => {
        function o() {}
        o.show = (d => o);
        o.hide = (() => o);
        o.text = (d => "");
        o.html = (d => "");
        o.destroy = (() => {});
        return o;
    });

    flameGraph = flamegraph()
        .width(GetFlameGraphWidth())
        .cellHeight(18)
        .transitionDuration(750)
        .minFrameSize(0)
        .transitionEase(d3.easeCubic)
        .sort(true)
        .title("")
        .onClick(onClick)
        .selfValue(false);

    flameGraph.label(labelHandler);
    flameGraph.tooltip(flameGraphTip());
    flameGraph.setColorMapper(function(d, originalColor) {
        return d.highlight? "#ff0000" : d.data.color; // original search() functionality
    });
    flameGraph.setDetailsElement(detailsHidden);
}

function InitDiffUi() {
    if (viewMode == ViewModes.Diff) {
        InitSlider(UpdateDiffColors);
    }

    // Create an observer instance
    var observer = new MutationObserver(function(mutationsList, observer) {
        for(var mutation of mutationsList) {
            details.innerHTML = mutation.target.textContent;
        }
    });
    // Configuration of the observer:
    var config = { attributes: true, childList: true, characterData: true, subtree: true };
    // Start observing the target node for configured mutations
    observer.observe(detailsHidden, config);
}

function AddSelectorOption(selectorEl, text, val) {
    var option = document.createElement("option");
    option.text = text;
    option.value = val;
    selectorEl.add(option);
}

function InitUi() {
    document.getElementById("form").addEventListener("submit", function(event){
        event.preventDefault();
        search();
    });

    var hasBottomUp = (containers_json[0].bottomUp != undefined);
    if (hasBottomUp) {
        var topDownButton = document.getElementById('TopDownButton');
        topDownButton.style.display = "";
    }

    var graphSelector = document.getElementById('GraphSelector');
    containers_json.forEach((entry, i) => {
        AddSelectorOption(graphSelector, entry.title, i);
    });

    var hasMultipleGraphs = (containers_json.length > 1);
    if (hasMultipleGraphs) {
        graphSelector.style.display = "";
    }

    var sensSelector = document.getElementById('SensModeSelector');
    AddSelectorOption(sensSelector, "Comparison: relative", 0);
    AddSelectorOption(sensSelector, "Comparison: absolute", 1);
    if (viewMode == ViewModes.Diff) {
        sensSelector.style.display = "";
    }

    InitDiffUi();
}

function ShowUi() {
    var spinner = document.getElementById('Spinner');
    var mainView = document.getElementById('MainView');
    spinner.style.display = "none";
    mainView.style.display = "";
    ResizeFlameGraph();
    window.addEventListener("resize", ResizeFlameGraph);
}

function SelectGraph() {
    var container = containers_json[containerId];
    UpdateDiffGraph(container.title);

    selected_container = container;
    selected_graph = topDown ? container.topDown : container.bottomUp;
    UpdateGraphColors(selected_graph);
}

function UpdateNodeTextColor() {
    const rects = document.querySelectorAll("rect");
    rects.forEach(rect => {
        const fillColor = rect.getAttribute("fill");
        if (!fillColor)
            return;
        if (viewMode == ViewModes.Diff) {
            if (searchStr && fillColor.length < mismatchColor.length) {
                rect.setAttribute("style", "stroke: #DF00FF; stroke-width: 2;");
            } else {
                rect.setAttribute("style", "");
            }
        }
        var k = Number(fillColor.substring(1, 2));
        var isDarkFill = (k <= 4);
        const rr = fillColor.substring(1, 3);
        const gg = fillColor.substring(3, 5);
        var isBlueFill = (rr == gg);
        const foreignObject = rect.nextElementSibling;
        if (foreignObject) {
            const div = foreignObject.querySelector(".d3-flame-graph-label");
            if (div) {
                div.style.color = (isDarkFill && isBlueFill) ? "white" : "";
            }
        }
    });
}

function SetFlameGraphData() {
    flameGraph.inverted(!topDown);
    flameGraph.width(GetFlameGraphWidth());
    d3.select("#chart")
    .datum(selected_graph)
    .call(flameGraph);
    UpdateNodeTextColor();
}

function OnSelectGraph() {
    var combo = document.getElementById("GraphSelector");
    containerId = combo.selectedIndex;
    SelectGraph();
    SetFlameGraphData();
}

function OnSelectSensMode() {
    UpdateDiffColors();
}

///////////////////////////////////////////////////////////////////////////
function GetSelectedUnitsFormat() {
    var res = {};
    res.units = selected_container.units;
    res.sensAbsMax = 100;
    res.total = (viewMode == ViewModes.Default) ? ",d" : ",.1f";
    res.avg = ",.2f";
    if (res.units == "ms") {
        res.sensAbsMax = 10;
        res.total = ".3f";
        res.avg = ".3f";
    } else if (res.units == "bytes") {
        res.sensAbsMax = 10000;
    }
    return res;
}

var labelHandler = function (d) {
    var format = GetSelectedUnitsFormat();

    function GetLabelLineStyle(sideId) {
        const titles = ['Left:&nbsp;&nbsp;', 'Right:'];
        const colors = ['#32d232', '#5252d2'];
        var otherId = 1 - sideId;
        var style = "";
        var postfix = "";
        var sideValues = d.data.sideValues[sideId];
        var otherSideValues = d.data.sideValues[otherId];
        if (sideValues.isHighlighted) {
            style = ' style="color:white;background-color:' + colors[sideId] + ';"';
            postfix = " &#x2B60; ";
            if (otherSideValues.displayValue == 0 && sideValues.displayValue > 0) {
                postfix += "exists only here";
            } else {
                var diffHigher = sideValues.displayValue - otherSideValues.displayValue;
                var diffHigherStr = d3.format(format.total)(diffHigher) + (' ' + format.units).trimEnd();
                var percentHigher = (sideValues.displayValue / otherSideValues.displayValue - 1) * 100;
                var percentHigherStr = (percentHigher >= 10000) ? "MUCH" : (d3.format('.2f')(percentHigher) + "%");
                postfix += "total is " + percentHigherStr + " (" + diffHigherStr + ") higher";
            }
        }
        var prefix = '<span' + style + '>' + titles[sideId] + '</span>&nbsp;';
        return {
            prefix: prefix,
            postfix: postfix
        };
    }

    function ComposeLabelLine(prefix, postfix, percent, total, avg) {
        return prefix +
            d3.format('.2f')(percent) + '% | ' +
            d3.format(format.total)(total) + (' ' + format.units).trimEnd() + ' total | ' +
            d3.format(format.avg)(avg) + (' ' + format.units).trimEnd() + ' avg' +
            postfix;
    }

    var tiPostfix = (viewMode == ViewModes.Default) ? (', Timer Index: ' + d.data.timerIndex) : "";
    var identifier = d.data.name + ' (Group Name: ' + d.data.groupName + tiPostfix + ')';

    if (viewMode == ViewModes.Diff || viewMode == ViewModes.Combo) {
        const isDiff = (viewMode == ViewModes.Diff);
        const sides = isDiff ? 2 : 1;
        for (var sideId = 0; sideId < sides; sideId++) {
            var rootDisplayValue = selected_graph.sideValues[sideId].displayValue;
            var sideValues = d.data.sideValues[sideId];
            var style = isDiff ? GetLabelLineStyle(sideId) : { prefix: "", postfix: "" };
            var percent = 100 * sideValues.displayValue / rootDisplayValue;
            var total = sideValues.displayValue;
            var avg = sideValues.displayCount > 0 ? sideValues.displayValue / sideValues.displayCount : 0;
            identifier += '<br/>';
            identifier += ComposeLabelLine(style.prefix, style.postfix, percent, total, avg);
        }
        identifier += '<br/>';
        identifier += 'per ' + normalizedNumberOfFrames + ' frame' + (normalizedNumberOfFrames > 1 ? "s" : "");
    } else {
        var percent = 100 * (d.x1 - d.x0);
        var total = d.data.displayValue;
        var avg = d.data.displayValue / d.data.displayCount;
        identifier += '<br/>';
        identifier += ComposeLabelLine("", "", percent, total, avg);
    }

    return identifier;
}

///////////////////////////////////////////////////////////////////////////
function TimeString(Diff) {
    var DiffString = "0 sec";
    var DiffTable = [1, 60, 60*60, 60*60*24];
    var DiffNameTable = ["sec", "min", "hr", "day"];
    for (var i = 0; i < DiffTable.length; ++i) {
        if(Diff >= DiffTable[i]) {
            var val = Diff / DiffTable[i];
            var diffName = DiffNameTable[i];
            DiffString = Math.floor(val) + " " + diffName;
            if (diffName == "day" && val > 1) {
                DiffString += 's'; //days
            }
        }
    }
    return DiffString;
}

function GetTimeInfo(utc, noPostfix) {
    var res = {};
    var CurrentDate = Date.now() / 1000;
    var Diff = CurrentDate - utc;
    var postfix = noPostfix ? "" : " ago";
    res.diffStr = TimeString(Diff) + postfix;
    res.dateStr = new Date(utc * 1000).toLocaleString();
    return res;
}

function IterateSourceContainers(func) {
    var defaultTitle = source_containers_json[0].title;
    source_containers_json.forEach(source_container => {
        if (source_container.title != defaultTitle)
            return;
        func(source_container);
    });
}

function SetPlaceIdText() {
    function GetPlaceIdInfo(sideId) {
        const placeIdSet = new Set();
        IterateSourceContainers(source_container => {
            if (source_container.dumpInfo.localGroupId != sideId)
                return;
            placeIdSet.add(source_container.dumpInfo.placeId);
        });
        var res = {};
        var isSingleId = (placeIdSet.size == 1);
        res.placeIdText = isSingleId ? String(placeIdSet.values().next().value) : 'mixed';
        res.placeIdUrl = (isSingleId && res.placeIdText != '0') ? 'https://www.roblox.com/games/' + res.placeIdText : '#';
        return res;
    }

    function GetPlaceIdHtml(sideId, bgColor, whitePrefix, prefix, url, text) {
        const ids = ['leftTitle', 'rightTitle'];
        const prefixColor = whitePrefix ? 'white' : 'black';
        var style = bgColor ? ('color:' + prefixColor + ';background-color:' + bgColor + ';') : 'border: 1px solid black;';
        style += 'cursor: default;';
        var html = '<span id="' + ids[sideId] + '" style="' + style + '">&nbsp;' + prefix + '&nbsp;</span> PlaceId:<a href="' + url + '">' + text + '</a>';
        return html;
    }

    var html = '';
    var pid0 = GetPlaceIdInfo(0);
    var pid1 = GetPlaceIdInfo(1);
    if (viewMode == ViewModes.Diff) {
        html += GetPlaceIdHtml(0, '#32d232', true, 'Left', pid0.placeIdUrl, pid0.placeIdText);
        html += ' &nbsp; ';
        html += GetPlaceIdHtml(1, '#5252d2', true, 'Right', pid1.placeIdUrl, pid1.placeIdText);
    } else if (viewMode == ViewModes.Combo) {
        html += GetPlaceIdHtml(0, '#d2d2d2', false, 'Dumps', pid0.placeIdUrl, pid0.placeIdText);
    } else {
        html += GetPlaceIdHtml(0, "", false, 'Dump', pid0.placeIdUrl, pid0.placeIdText);
    }
    dumpsInfo.innerHTML = html;

    var leftTitle = document.getElementById("leftTitle");
    var rightTitle = document.getElementById("rightTitle");
    if (leftTitle) {
        leftTitle.addEventListener('mouseenter', function(event) {
            UpdateTitleLabel(0);
        });
        leftTitle.addEventListener('mouseleave', function(event) {
            ClearDetailsLabel();
        });
    }
    if (rightTitle) {
        rightTitle.addEventListener('mouseenter', function(event) {
            UpdateTitleLabel(1);
        });
        rightTitle.addEventListener('mouseleave', function(event) {
            ClearDetailsLabel();
        });
    }
}

function SetTimeText() {
    function GetCaptureTimeInfo() {
        const times = [];
        IterateSourceContainers(source_container => {
            times.push(source_container.dumpInfo.utcCaptureTime);
        });
        var res = {};
        res.minTime = Math.min(...times);
        res.maxTime = Math.max(...times);
        return res;
    }

    function GetGraphsCount(sideId) {
        var res = 0;
        IterateSourceContainers(source_container => {
            if (source_container.dumpInfo.localGroupId != sideId)
                return;
            res++;
        });
        return res;
    }

    var captureTimeInfo = GetCaptureTimeInfo();
    var minTimeInfo = GetTimeInfo(captureTimeInfo.minTime);
    var maxTimeInfo = GetTimeInfo(captureTimeInfo.maxTime);
    var countSide0 = GetGraphsCount(0);
    var countSide1 = GetGraphsCount(1);

    var line1 = '';
    var line2 = '';
    if (viewMode == ViewModes.Diff || viewMode == ViewModes.Combo) {
        const isDiff = (viewMode == ViewModes.Diff);
        const dumpsCount = isDiff ? countSide0 + "+" + countSide1 : countSide0;
        line1 = "# of dumps: " + dumpsCount + "&nbsp; Collection time range: " + minTimeInfo.diffStr + " &mdash; " + maxTimeInfo.diffStr;
        line2 = minTimeInfo.dateStr + " &mdash; " + maxTimeInfo.dateStr;
    } else {
        const numberOfFrames = source_containers_json[0].dumpInfo.numberOfFrames;
        line1 = "# of frames: " + numberOfFrames + "&nbsp; Collection time: " + minTimeInfo.diffStr;
        line2 = minTimeInfo.dateStr;
    }
    collectionTime.innerHTML = line1;
    collectionTimeAgo.innerHTML = line2;
}

function UpdateTitleLabel(sideId) {
    var label = '';
    label += '<table style="width:100%;">\n';
    label += '<thead>\n';
    label += '<tr>\n';
    label += '    <th>Dump file name</th>\n';
    label += '    <th>Number of frames</th>\n';
    label += '    <th>Place ID</th>\n';
    label += '    <th>Date</th>\n';
    label += '    <th>Age</th>\n';
    label += '</tr>\n';
    label += '</thead>\n';
    label += '<tbody>\n';

    IterateSourceContainers(source_container => {
        if (source_container.dumpInfo.localGroupId != sideId)
            return;
        var di = source_container.dumpInfo;
        var timeInfo = GetTimeInfo(di.utcCaptureTime);
        label += '<tr>\n';
        label += '<td>' + di.fileName + '</td>';
        label += '<td>' + di.numberOfFrames + '</td>';
        label += '<td>' + di.placeId + '</td>';
        label += '<td>' + timeInfo.dateStr + '</td>';
        label += '<td>' + timeInfo.diffStr + '</td>';
        label += '</tr>\n';
    });

    label += '</tbody>\n';
    label += "</table>\n";
    details.innerHTML = label;
}

function MakeGradientText(str, rMask, gMask, bMask) {
    var res = '';
    for (var i = 0; i < str.length; i++) {
        var coef = 1 - i / str.length;
        var color = RgbCoeffsToColor(coef * rMask, coef * gMask, coef * bMask);
        var c = str[i];
        res += '<span style="color:' + color + ';">' + c + '</span>';
    }
    return res;
}

function InitPageHeader() {
    var titleHtml = 'MicroProfiler Flamegraph';
    if (viewMode == ViewModes.Diff) {
        titleHtml = MakeGradientText('Diff', 1, 0, 1) + ' ' + MakeGradientText('Flamegraph', 1, 1, 0);
    } else if (viewMode == ViewModes.Combo) {
        titleHtml = 'Combo Flamegraph';
    }
    placeIdTitle.innerHTML = titleHtml;

    SetPlaceIdText();
    SetTimeText();
}

function DetectViewMode() {
    const localIdsSet = new Set();
    const localGroupIdsSet = new Set();
    IterateSourceContainers(source_container => {
        localIdsSet.add(source_container.dumpInfo.localId);
        localGroupIdsSet.add(source_container.dumpInfo.localGroupId);
    });
    const singleLocalId = (localIdsSet.size == 1);
    const singleLocalGroupId = (localGroupIdsSet.size == 1);

    viewMode = ViewModes.Default;
    if (!singleLocalGroupId) {
        viewMode = ViewModes.Diff;
    } else if (!singleLocalId) {
        viewMode = ViewModes.Combo;
    }
}

///////////////////////////////////////////////////////////////////////////
function NormalizeByNumberOfFrames(val, numberOfFrames) {
    var res = (numberOfFrames > 0) ? val * (normalizedNumberOfFrames / numberOfFrames) : 0;
    return res;
}

function ProcessDiffGraphNode(in_node, hash, sideId, numberOfFrames) {
    var outNode;
    var isOutNodeNew;

    var displayValueNormalized = NormalizeByNumberOfFrames(in_node.displayValue, numberOfFrames);
    var displayCountNormalized = NormalizeByNumberOfFrames(in_node.displayCount, numberOfFrames);

    var outNodeCached = hash2node[hash];
    if (outNodeCached) {
        isOutNodeNew = false;
        outNode = outNodeCached;
    } else {
        isOutNodeNew = true;
        outNode = {
            name: in_node.name,
            value: 0,
            sideValues: [
                { displayValue: 0, displayCount: 0, isHighlighted: false },
                { displayValue: 0, displayCount: 0, isHighlighted: false },
            ],
            color: in_node.color,
            groupName: in_node.groupName,
            timerIndex:  in_node.timerIndex,
            children: []
        };
        hash2node[hash] = outNode;
    }
    outNode.sideValues[sideId].displayValue += displayValueNormalized;
    outNode.sideValues[sideId].displayCount += displayCountNormalized;

    in_node.children.forEach(in_node_child => {
        var child_hash = hash + "|" + in_node_child.name;
        var processed_child = ProcessDiffGraphNode(in_node_child, child_hash, sideId, numberOfFrames);
        if (processed_child.isOutNodeNew) {
            outNode.children.push(processed_child.outNode);
        }
    });

    return {
        outNode: outNode,
        isOutNodeNew: isOutNodeNew
    };
}

///////////////////////////////////////////////////////////////////////////
function Clamp(v, a, b) {
    return Math.min(Math.max(v, a), b);
}

function ColorCoefToHex(coef) {
    var vMin = 30;
    var vMax = (coef > 0 ? 190 : 210);
    var vDelta = vMax - vMin;
    var coef255 = Clamp(vMax - Math.floor(coef * vDelta), vMin, vMax);
    let coefHex = coef255.toString(16);
    if (coefHex.length < 2) {
        coefHex = "0" + coefHex;
    }
    return coefHex;
}

function RgbCoeffsToColor(r, g, b) {
    return "#" + ColorCoefToHex(r) + ColorCoefToHex(g) + ColorCoefToHex(b);
}

function SideValuesToColor(sideValues) {
    var coefs = GetSensitivityCoefs();
    var v0 = sideValues[0].displayValue;
    var v1 = sideValues[1].displayValue;
    var vMax = Math.max(v0, v1);
    var vMin = Math.min(v0, v1);
    var coef = (vMin == 0 ? 1 : (Math.min(vMax / vMin, 2.0) - 1));
    if (coefs.isAbs) {
        coef = (vMin == 0 ? coefs.max : (vMax - vMin));
    }
    coef = Math.max(Math.min(coef, coefs.max) - coefs.min, 0) / (coefs.max - coefs.min);
    coef = Math.min(coef, 1);

    var color;
    var highlight = [false, false];
    if (coef == 0) {
        color = RgbCoeffsToColor(0, 0, 0);
    } else if (v0 > v1) {
        color = RgbCoeffsToColor(coef, 0, coef);
        highlight[0] = true;
    } else {
        color = RgbCoeffsToColor(coef, coef, 0);
        highlight[1] = true;
    }

    sideValues[0].isHighlighted = highlight[0];
    sideValues[1].isHighlighted = highlight[1];
    return color;
}

///////////////////////////////////////////////////////////////////////////
function ResetGeneratedGraphValues() {
    hash2node = [];
}

function NormalizeSideValues(sideValues, sideId, rootSideValues) {
    var sv = sideValues[sideId];
    sv.displayValue = NormalizeByNumberOfFrames(sv.displayValue, rootSideValues[sideId].numberOfFrames);
    sv.displayCount = NormalizeByNumberOfFrames(sv.displayCount, rootSideValues[sideId].numberOfFrames);
}

function NormalizeGraphValues(in_node, rootSideValues) {
    NormalizeSideValues(in_node.sideValues, 0, rootSideValues);
    NormalizeSideValues(in_node.sideValues, 1, rootSideValues);
    in_node.value = in_node.sideValues[0].displayValue + in_node.sideValues[1].displayValue;
    in_node.children.forEach(in_node_child => {
        NormalizeGraphValues(in_node_child, rootSideValues);
    });
}

function UpdateGraphColors(in_node) {
    if (viewMode != ViewModes.Diff)
        return;
    in_node.color = (!searchStr || in_node.name.toLowerCase().startsWith(searchStr)) ? SideValuesToColor(in_node.sideValues) : mismatchColor;
    in_node.children.forEach(in_node_child => {
        UpdateGraphColors(in_node_child);
    });
}

function InitDiffGraphs() {
    if (viewMode == ViewModes.Default) {
        containers_json = source_containers_json;
        return;
    }

    const titlesSet = new Set();
    source_containers_json.forEach(source_container => {
        if (!titlesSet.has(source_container.title)) {
            var id = titlesSet.size;
            var g = containers_json[id] = {};
            g.dumpInfo = {};
            g.title	= source_container.title;
            g.shortName	= source_container.shortName;
            g.units	= source_container.units;
            g.topDown = undefined;
            titlesSet.add(source_container.title);
        }
    });
}

function UpdateDiffGraph(title) {
    var found_container;
    containers_json.forEach(container => {
        if (container.title != title)
            return;
        found_container = container;
    });

    if (found_container.topDown)
        return;

    var rootSideValues = [{ numberOfFrames: 0 }, { numberOfFrames: 0 }];
    var td;
    source_containers_json.forEach(source_container => {
        if (source_container.title != title)
            return;
        var sideId = source_container.dumpInfo.localGroupId;
        td = ProcessDiffGraphNode(source_container.topDown, source_container.topDown.name, sideId, source_container.dumpInfo.numberOfFrames).outNode;
        rootSideValues[sideId].numberOfFrames += normalizedNumberOfFrames;
    });
    NormalizeGraphValues(td, rootSideValues);
    td.sideValues[0].displayCount = 1;
    td.sideValues[1].displayCount = 1;

    found_container.topDown = td;
    ResetGeneratedGraphValues();
}

function UpdateDiffColors() {
    UpdateGraphColors(selected_graph);
    SetFlameGraphData();
}

///////////////////////////////////////////////////////////////////////////
function search() {
    let term = document.getElementById("term").value;
    if (viewMode == ViewModes.Diff) {
        searchStr = term.toLowerCase();
        UpdateDiffColors();
    } else {
        flameGraph.search(term);
    }
}

function clear() {
    document.getElementById('term').value = '';
    if (viewMode == ViewModes.Diff) {
        searchStr = '';
        UpdateDiffColors();
    } else {
        flameGraph.clear();
    }
}

function resetZoom() {
    flameGraph.resetZoom();
}

function onClick(d) {
    console.info("Clicked on " + d.data.name);
}

function topDownToggle() {
    var topDownButton = document.getElementById('TopDownButton');
    if (topDown == true) {
        topDownButton.textContent = "Bottom Up";
        topDown = false;
    } else {
        topDownButton.textContent = "Top Down";
        topDown = true;
    }
    OnSelectGraph();
}

///////////////////////////////////////////////////////////////////////////
function PrintTopDiffs(containerShortName, topCount, parsedRules) {
    let diffs = Array();
    let rootSideValues = selected_graph.sideValues;

    function CalcDiff(in_node, name) {
        let isIncrease = false;
        let vMin = 0;
        let vMax = 0;

        let v0 = in_node.sideValues[0].displayValue;
        let v1 = in_node.sideValues[1].displayValue;
        if (v1 > v0) {
            isIncrease = true;
            vMin = v0;
            vMax = v1;
        } else if (v0 > v1) {
            vMin = v1;
            vMax = v0;
        } else {
            return;
        }

        let diff = {
            rawVal: v1 - v0,
            absVal: vMax - vMin,
            rawPercent: 0,
            absPercent: 0,
            isMuch: false,
            isArised: isIncrease && v0 == 0,
            isGone: !isIncrease && v1 == 0,
            name: name,
            node: in_node,
        };

        if (!diff.isArised && !diff.isGone) {
            diff.absPercent = (vMax / vMin - 1) * 100;
            diff.rawPercent = diff.absPercent * (isIncrease ? 1 : -1);
            diff.isMuch = (diff.absPercent >= 10000);
        }

        diffs.push(diff);

        in_node.children.forEach(in_node_child => {
            CalcDiff(in_node_child, diff.name + (diff.name != "/" ? "/" : "") + in_node_child.name);
        });
    }

    CalcDiff(selected_graph, "/");
    diffs.sort((a, b) => b.absVal - a.absVal);

    function GetSelectedUnitsFormatSimple() {
        let units = selected_container.units;
        let res = {
            unitsName: units,
            unitsShortName: units,
            digitNum: 2,
        };
        if (units == "ms") {
            res.digitNum = 3;
        } else if (units == "bytes") {
            res.unitsShortName = "b";
            res.digitNum = 1;
        } else if (units == "") {
            res.digitNum = 1;
        }
        return res;
    }

    function ToPrintable(x, digitNum, unit) {
        let str = x.toFixed(digitNum).toString() + unit;
        if (x > 0) {
            str = "+" + str;
        }
        return str;
    }

    function UndefinedToNumber(x) {
        return x ? x : 0;
    }

    function PushFields(fields) {
        outLines.push(fields);
        for (let j = 0; j < fields.length - 1; j++) {
            maxFieldLens[j] = Math.max(UndefinedToNumber(maxFieldLens[j]), fields[j].length);
        }
    }

    function CheckRules(diff) {
        for (const [id, rule] of parsedRules.entries()) {
            if (rule.containerShortName != containerShortName)
                continue;
            let res = false;
            if (rule.isMore && diff.rawVal > rule.val)
                res = true;
            if (!rule.isMore && diff.rawVal < rule.val)
                res = true;
            if (res && rule.nameMaskRegexp.test(diff.name))
                return id;
        }
        return -1;
    }

    let outLines = Array();
    let maxFieldLens = [];
    let headerFields = [
        " ",
        "Diff,raw",
        "Diff,%",
        "Scope name",
    ];
    PushFields(headerFields);
    let unitsFormat = GetSelectedUnitsFormatSimple();
    for (let i = 0; i < diffs.length; i++) {
        const diff = diffs[i];

        const ruleMatchId = CheckRules(diff);
        const ruleMatch = (ruleMatchId >= 0);
        const ruleMatchStr = ruleMatch ? "*" : " ";
        if (ruleMatch && cpp) {
            cpp.RuleTriggered(ruleMatchId);
        }

        if ((topCount > 0) && (i >= topCount) && !ruleMatch)
            continue;

        let rawPercentStr = ToPrintable(diff.rawPercent, 2, "%");
        if (diff.isMuch) {
            rawPercentStr = "MUCH%"
        }
        if (diff.isArised) {
            rawPercentStr = "(arised)"
        } else if (diff.isGone) {
            rawPercentStr = "(gone)"
        }
        let fields = [
            ruleMatchStr,
            ToPrintable(diff.rawVal, unitsFormat.digitNum, unitsFormat.unitsShortName),
            rawPercentStr,
            diff.name,
        ];
        PushFields(fields);
    }

    for (let i = 0; i < outLines.length; i++) {
        let line = "";
        let fields = outLines[i];
        for (let j = 0; j < fields.length; j++) {
            let field = fields[j];
            let isFirst = (j == 0);
            let isLast = (j == fields.length - 1);
            const padding = isFirst ? "" : "  ";
            line += padding;
            if (isLast) {
                line += field;
            } else {
                line += field.padStart(maxFieldLens[j]);
            }
        }
        console.log(line);
    }
}

function ProcessContainers(topCount, rules) {
    const defaultTopCount = 0;
    topCount = topCount ? topCount : defaultTopCount;
    rules = rules ? rules : [];

    function RemoveNonDigitsFromRight(str) {
        let i = str.length - 1;
        while (i >= 0 && (str[i] < '0' || str[i] > '9')) {
            i--;
        }
        return str.slice(0, i + 1);
    }

    function ParseRule(input) {
        const parts = input.split(';').map(part => part.trim());
        let lastPart = parts[2] || '';
        const result = {
            nameMask: parts[0] || '',
            nameMaskRegexp: null,
            containerShortName: parts[1] || '',
            val: RemoveNonDigitsFromRight(lastPart).slice(1),
            isMore: lastPart.startsWith('>'),
            isPercent: lastPart.endsWith('%'),
        };
        const regexPattern = '^' + result.nameMask.split('*').join('.*').split('?').join('.') + '$';
        result.nameMaskRegexp = new RegExp(regexPattern);
        return result;
    }

    let parsedRules = [];
    for (const rule of rules) {
        parsedRules.push(ParseRule(rule));
    }

    console.log("");
    console.log("== Top diffs (Left => Right. Total values compared. Per 1 frame) ==");
    console.log("");

    containers_json.forEach((entry, i) => {
        let title = "## " + entry.title + " [" + entry.shortName + "]";
        let containerShortName = entry.shortName;
        console.log(title);
        console.log("-".repeat(title.length));

        containerId = i;
        SelectGraph();
        PrintTopDiffs(containerShortName, topCount, parsedRules);

        console.log("");
    });
}

///////////////////////////////////////////////////////////////////////////
if (globalThis.g_cliMode) {
    DetectViewMode();
    InitDiffGraphs();
} else {
    InitFlameGraph();
    DetectViewMode();
    InitPageHeader();
    InitDiffGraphs();
    InitUi();
    OnSelectGraph();
    ShowUi();
}
</script>
</body>
</html>`;
    const options = {};
    let modelPromise = null;
    let captureSourcePromise = null;
    let captureBytesPromise = null;
    let runtimePromise = null;
    let activeSegmentFrameTimeSource = null;
    const segmentFrameTimeCache = new Map();
    let activeSegmentIndex = 0;
    let availableSegmentCount = null;

    function isNode() {
        return typeof process !== "undefined" && Boolean(process.versions?.node);
    }

    if (!isNode() && typeof root.addEventListener === "function") {
        root.addEventListener("pagehide", () => {
            activeSegmentFrameTimeSource?.dispose();
            activeSegmentFrameTimeSource = null;
        }, { once: true });
    }

    function findBytes(data, pattern, start = 0) {
        outer: for (let i = start; i + pattern.length <= data.length; ++i) {
            for (let j = 0; j < pattern.length; ++j) {
                if (data[i + j] !== pattern[j])
                    continue outer;
            }
            return i;
        }
        return -1;
    }

    function captureFromHtmlBytes(bytes) {
        const marker = findBytes(bytes, HTML_COMMENT_CLOSE, MAGIC_PART_SIZE);
        if (marker < 0)
            throw new Error("The input does not contain a LibMP HTML comment boundary");
        return bytes.subarray(MAGIC_PART_SIZE, marker);
    }

    function captureTextFromDocument() {
        if (typeof document === "undefined")
            throw new Error("No browser document is available");
        for (const node of document.childNodes) {
            if (node.nodeType === 8 && node.data) // Node.COMMENT_NODE
                return node.data;
        }
        throw new Error("The document does not contain embedded GPRX data");
    }

    function createAsciiTextProvider(text) {
        const encoder = new TextEncoder();
        return {
            getSize: () => text.length,
            read(destination, blockId, offset, size) {
                if (blockId !== 0 || offset > BigInt(Number.MAX_SAFE_INTEGER))
                    return 0;
                const start = Number(offset);
                if (start > text.length || size > text.length - start)
                    return 0;
                const result = encoder.encodeInto(text.slice(start, start + size), destination);
                return result.read === size && result.written === size ? size : 0;
            },
        };
    }

    async function loadCaptureSource() {
        if (options.captureBytes) {
            const bytes = options.captureBytes instanceof Uint8Array
                ? options.captureBytes
                : new Uint8Array(options.captureBytes);
            return { bytes };
        }
        if (!isNode()) {
            const text = captureTextFromDocument();
            return { text, provider: createAsciiTextProvider(text) };
        }

        const fs = require("node:fs");
        const inputPath = options.inputPath || process.argv[2];
        if (!inputPath)
            throw new Error("Expected an input .x.html path as argv[2]");
        const bytes = fs.readFileSync(inputPath);
        const capture = bytes[0] === 0x3c && bytes[1] === 0x21 &&
            bytes[2] === 0x2d && bytes[3] === 0x2d
            ? captureFromHtmlBytes(bytes)
            : bytes;
        return { bytes: capture };
    }

    function resolveLibMP() {
        if (root.LibMP?.create)
            return root.LibMP;
        if (isNode()) {
            const loaded = require("./libmp.js");
            root.LibMP = loaded;
            return loaded;
        }
        throw new Error("libmp.js must be loaded before tools.js");
    }

    function getRuntime() {
        runtimePromise ||= resolveLibMP().create();
        return runtimePromise;
    }

    function getCaptureSource() {
        captureSourcePromise ||= loadCaptureSource();
        return captureSourcePromise;
    }

    function getCaptureBytes() {
        captureBytesPromise ||= getCaptureSource().then(source =>
            source.bytes || new TextEncoder().encode(source.text));
        return captureBytesPromise;
    }

    async function getCaptureText() {
        const source = await getCaptureSource();
        return source.text === undefined
            ? new TextDecoder("ascii").decode(source.bytes)
            : source.text;
    }

    function openCaptureSession(runtime, source) {
        return source.provider
            ? runtime.Session.OpenFromExternalProvider(source.provider)
            : runtime.Session.OpenFromBuffer(source.bytes);
    }

    function tickDiff(start, end) {
        let difference = (BigInt(end) - BigInt(start)) & (TICK_RANGE - 1n);
        if ((difference & TICK_SIGN) !== 0n)
            difference -= TICK_RANGE;
        return Number(difference);
    }

    function color(value) {
        return `#${(Number(value) & 0xffffff).toString(16).padStart(6, "0")}`;
    }

    function darkColor(value) {
        return color(((Number(value) >>> 1) & ~0x808080) >>> 0);
    }

    function formatCounter(value) {
        if (!Number.isFinite(value))
            return String(value);
        const sign = value < 0 ? "-" : "";
        const absolute = Math.abs(value);
        if (!Number.isInteger(absolute))
            return sign + String(absolute);
        return sign + String(absolute).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    }

    function mapReference(id, indexes) {
        return id === 0 ? -1 : (indexes.get(id) ?? -1);
    }

    function getCurrentEntryWords(iterator) {
        const count = iterator.GetCurrentEntryCount();
        if (count === 0)
            return null;
        const words = new Array(count);
        for (let index = 0; index < count; ++index) {
            const low = BigInt(iterator.GetCurrentEntryPart(index, 0));
            const high = BigInt(iterator.GetCurrentEntryPart(index, 1));
            words[index] = low | (high << 32n);
        }
        return words;
    }

    function eventWordsToViewer(words, startTick, labels, tt, ts, ti) {
        const first = words[0];
        const eventType = Number((first >> 50n) & 0xffn);
        const eventSize = Number((first >> 58n) & 3n);
        const hasLabel = ((first >> 60n) & 1n) !== 0n;
        if (eventSize > 2 || words.length < 1 + eventSize * 2)
            return null;
        let data = first & EVENT_DATA_MASK;
        if (eventType === EVENT_SPAN_BEGIN || eventType === EVENT_SPAN_END)
            data = BigInt.asUintN(50, BigInt(tickDiff(startTick, data)));

        tt.push(EVENT_BASE + eventType);
        ts.push(data | (BigInt(eventSize) << 58n));
        if (hasLabel) {
            ti.push(labels.length + 1);
            labels.push(LABEL_PLACEHOLDER);
        } else {
            ti.push(0);
        }

        for (let index = 0; index < eventSize; ++index) {
            const low = words[index * 2 + 1] & EVENT_DEPENDENT_DATA_MASK;
            const highWord = words[index * 2 + 2];
            tt.push(EVENT_BASE);
            ts.push(low | ((highWord & 0xffffffn) << 40n));
            ti.push(Number((highWord >> 24n) & 0xffffn));
        }
        return eventType;
    }

    function appendLogEntry(
        iterator, state, timerIndexes, threadStartTick, cpuStartTick, target) {
        const entryType = state.entryTypeRaw();
        if (entryType === LOG_META || state.isUnknown())
            return;
        const words = getCurrentEntryWords(iterator);
        if (!words)
            throw new Error("Unable to read the current log entry");
        if (state.isEvent()) {
            const eventType = eventWordsToViewer(
                words, threadStartTick, target.tl, target.tt, target.ts, target.ti);
            if (eventType !== null)
                target.eventTypesSeen.add(eventType);
            return;
        }

        if (entryType === LOG_LABEL || entryType === LOG_LABEL_LITERAL) {
            target.tt.push(LOG_LABEL);
            target.ts.push(0);
            target.ti.push(target.tl.length);
            target.tl.push(iterator.FetchCurrentLabel() ?? LABEL_PLACEHOLDER);
            return;
        }

        target.tt.push(entryType);
        const rawTick = words[0] & TICK_MASK;
        if (entryType === LOG_ENTER || entryType === LOG_LEAVE) {
            const timerIndex = timerIndexes.get(state.timerId());
            if (timerIndex === undefined)
                throw new Error(`Log entry references unknown timer ${state.timerId()}`);
            target.ts.push(tickDiff(threadStartTick, rawTick));
            target.ti.push(timerIndex);
        } else if (entryType === LOG_GPU_EXTRA) {
            // GPU-extra records carry a CPU-domain timestamp even on a GPU log.
            target.ts.push(tickDiff(cpuStartTick, rawTick));
            target.ti.push(0);
        } else {
            target.ts.push(0);
            target.ti.push(0);
        }
    }

    function calculateStatistics(frames, timers, groups, threadGpu, cpuScale, gpuScale) {
        const timerStats = timers.map(() => ({
            total: 0, max: 0, min: Infinity, exclusive: 0,
            exclusiveMax: 0, calls: 0,
        }));
        const groupStats = groups.map(() => ({ total: 0, max: 0 }));
        const threadGroupTimes = threadGpu.map(() => new Array(MAX_GROUPS).fill(0));
        const findGroup = name => groups.findIndex(
            group => !group.isGpu && group.name.toLowerCase() === name.toLowerCase());
        const jobsGroup = findGroup("Jobs");
        const renderGroup = findGroup("Render");
        const findRenderTimer = name => timers.findIndex(timer =>
            timer.group === renderGroup && timer.name.toLowerCase() === name.toLowerCase());
        const waitOnGpuTimer = findRenderTimer("waitOnGpu");
        const preRenderTimer = findRenderTimer("PreRender");
        const prepareTimer = findRenderTimer("Prepare");
        const performTimer = findRenderTimer("Perform");
        let sawPreRender = false;

        for (const frame of frames) {
            const frameTimer = timers.map(() => ({ sum: 0, exclusive: 0, calls: 0 }));
            const frameGroup = groups.map(() => 0);
            for (let thread = 0; thread < frame.tt.length; ++thread) {
                const timeScale = threadGpu[thread] ? gpuScale : cpuScale;
                const stack = [];
                const groupDepth = new Array(groups.length).fill(0);
                const types = frame.tt[thread];
                const times = frame.ts[thread];
                const indexes = frame.ti[thread];
                for (let i = 0; i < types.length; ++i) {
                    if (types[i] === LOG_ENTER) {
                        const timer = timers[indexes[i]];
                        if (!timer)
                            continue;
                        stack.push({ timer: indexes[i], start: times[i], child: 0 });
                        groupDepth[timer.group]++;
                    } else if (types[i] === LOG_LEAVE) {
                        const timerIndex = indexes[i];
                        const timer = timers[timerIndex];
                        if (!timer)
                            continue;
                        const frameStart = threadGpu[thread]
                            ? frame.framestartgpu / timeScale
                            : frame.framestart / timeScale;
                        const entry = stack.length
                            ? stack.pop()
                            : { timer: timerIndex, start: frameStart, child: 0 };
                        const elapsedTicks = Math.max(0, times[i] - entry.start);
                        const elapsed = elapsedTicks * timeScale;
                        const exclusive = Math.max(0, elapsed - entry.child);
                        if (stack.length)
                            stack[stack.length - 1].child += elapsed;
                        const stats = frameTimer[timerIndex];
                        stats.sum += elapsed;
                        stats.exclusive += exclusive;
                        stats.calls++;
                        const group = timer.group;
                        if (groupDepth[group] > 0)
                            groupDepth[group]--;
                        if (groupDepth[group] === 0) {
                            frameGroup[group] += elapsed;
                            if (group < MAX_GROUPS)
                                threadGroupTimes[thread][group] += elapsed;
                        }
                        if (!threadGpu[thread] && elapsedTicks > 0) {
                            const leaveTick = times[i];
                            if (group === jobsGroup)
                                frame.legacyJobsEndTick = Math.max(
                                    frame.legacyJobsEndTick, leaveTick);
                            else if (group === renderGroup)
                                frame.legacyRenderEndTick = Math.max(
                                    frame.legacyRenderEndTick, leaveTick);
                            if (timerIndex === waitOnGpuTimer)
                                frame.cpuWaitTicks += elapsedTicks;
                            if (timerIndex === preRenderTimer) {
                                frame.preRenderEndTick = leaveTick;
                                sawPreRender = true;
                            }
                        }
                    }
                }
            }

            for (let i = 0; i < timerStats.length; ++i) {
                const aggregate = timerStats[i];
                const current = frameTimer[i];
                aggregate.total += current.sum;
                aggregate.max = Math.max(aggregate.max, current.sum);
                aggregate.min = Math.min(aggregate.min, current.sum);
                aggregate.exclusive += current.exclusive;
                aggregate.exclusiveMax = Math.max(aggregate.exclusiveMax, current.exclusive);
                aggregate.calls += current.calls;
            }
            for (let i = 0; i < groupStats.length; ++i) {
                groupStats[i].total += frameGroup[i];
                groupStats[i].max = Math.max(groupStats[i].max, frameGroup[i]);
            }
            frame._timerSums = frameTimer.map(stats => stats.sum);
        }

        // The engine does not persist the MovePrerender flags. An active exact
        // PreRender/Prepare/Perform trio is the observable signature of its V2 path.
        const movedPreRender = sawPreRender &&
            prepareTimer >= 0 && performTimer >= 0;
        const wallTimeMode = movedPreRender
            ? "moved-prerender-inferred"
            : jobsGroup >= 0 && renderGroup >= 0
            ? "group-completion"
            : "unavailable";
        for (const frame of frames) {
            const frameStartTick = cpuScale > 0 ? frame.framestart / cpuScale : 0;
            const frameEndTick = cpuScale > 0 ? frame.frameend / cpuScale : frameStartTick;
            const clampToFrame = tick => Math.max(
                frameStartTick, Math.min(tick || frameStartTick, frameEndTick));
            frame.cpuWaitsForGpu = frame.cpuWaitTicks * cpuScale;
            frame.wallTimesAvailable = wallTimeMode !== "unavailable";
            if (movedPreRender) {
                const renderDuration =
                    (frame._timerSums?.[prepareTimer] || 0) +
                    (frame._timerSums?.[performTimer] || 0);
                frame.jobsWallTime = clampToFrame(frame.preRenderEndTick) * cpuScale;
                frame.renderWallTime = frame.framestart + renderDuration;
            } else if (frame.wallTimesAvailable) {
                frame.jobsWallTime = clampToFrame(frame.legacyJobsEndTick) * cpuScale;
                frame.renderWallTime = clampToFrame(frame.legacyRenderEndTick) * cpuScale;
            } else {
                frame.jobsWallTime = 0;
                frame.renderWallTime = 0;
            }
            delete frame._timerSums;
            delete frame.cpuWaitTicks;
            delete frame.legacyJobsEndTick;
            delete frame.legacyRenderEndTick;
            delete frame.preRenderEndTick;
        }

        const frameCount = Math.max(frames.length, 1);
        for (let i = 0; i < timers.length; ++i) {
            const timer = timers[i];
            const stats = timerStats[i];
            timer.average = stats.total / frameCount;
            timer.max = stats.max;
            timer.min = Number.isFinite(stats.min) ? stats.min : 0;
            timer.exclaverage = stats.exclusive / frameCount;
            timer.exclmax = stats.exclusiveMax;
            timer.callaverage = stats.calls ? stats.total / stats.calls : 0;
            timer.callcount = stats.calls;
            timer.total = stats.total;
        }
        for (let i = 0; i < groups.length; ++i) {
            groups[i].total = groupStats[i].total;
            groups[i].average = groupStats[i].total / frameCount;
            groups[i].max = groupStats[i].max;
        }
        return { threadGroupTimes, wallTimeMode };
    }

    async function buildViewerModel(session) {
        const global = session.FetchGlobalDesc();
        if (!global)
            throw new Error("The capture has no global descriptor");
        const frameIdMin = session.GetFrameIdMin();
        const frameIdMax = session.GetFrameIdMax();
        const frameCount = frameIdMax > 0 && frameIdMax >= frameIdMin
            ? frameIdMax - frameIdMin + 1
            : 0;

        const groups = [];
        const groupIndexes = new Map();
        for (let id = 1; id <= session.GetGroupIdMax(); ++id) {
            const group = session.FetchGroupDesc(id);
            if (!group)
                continue;
            groupIndexes.set(id, groups.length);
            groups.push({
                sourceId: id,
                name: group.groupName || "",
                color: group.color,
                isGpu: Boolean(group.isGpu),
                timerCount: 0,
                total: 0,
                average: 0,
                max: 0,
            });
        }

        const timers = [];
        const timerIndexes = new Map();
        for (const id of session.FetchTimerIds()) {
            const timer = session.FetchTimerDesc(id);
            if (!timer)
                continue;
            const group = groupIndexes.get(timer.groupId);
            if (group === undefined)
                continue;
            timerIndexes.set(id, timers.length);
            groups[group].timerCount++;
            timers.push({
                sourceId: id,
                name: timer.timerName || "",
                group,
                color: timer.color,
                average: 0,
                max: 0,
                min: 0,
                exclaverage: 0,
                exclmax: 0,
                callaverage: 0,
                callcount: 0,
                total: 0,
            });
        }

        const threadIds = session.FetchThreadIds();
        const threads = [];
        for (const id of threadIds) {
            const thread = session.FetchThreadDesc(id);
            if (!thread)
                continue;
            threads.push({
                id,
                name: thread.threadName || "",
                isGpu: Boolean(thread.isGpu),
                bufferSize: thread.bufferSize,
                clobbered: false,
            });
        }
        // Match legacy raw dumps: keep GPU first, then preserve the intentional
        // leading-space ordering of CPU thread names.
        threads.sort((left, right) => {
            if (left.isGpu !== right.isGpu)
                return left.isGpu ? -1 : 1;
            if (left.name < right.name)
                return -1;
            if (left.name > right.name)
                return 1;
            return left.id - right.id;
        });
        const threadIndexes = new Map();
        for (let index = 0; index < threads.length; ++index)
            threadIndexes.set(threads[index].id, index);

        const frames = [];
        const frameIndexes = new Map();
        const eventTypesSeen = new Set();
        let firstCpuTick = 0n;
        let firstGpuTick = 0n;
        for (let offset = 0; offset < frameCount; ++offset) {
            const id = frameIdMin + offset;
            const frame = session.FetchFrameDesc(id);
            if (!frame)
                continue;
            if (frames.length === 0) {
                firstCpuTick = BigInt(frame.tickStartCpu);
                firstGpuTick = BigInt(frame.tickStartGpu);
            }
            for (const log of frame.threadLogs || []) {
                const thread = threads[threadIndexes.get(log.threadId)];
                if (thread && log.isRemoved)
                    thread.clobbered = true;
            }
            frameIndexes.set(id, frames.length);
            frames.push({
                sourceId: id,
                absoluteId: frame.frameAbsoluteId,
                framestart: tickDiff(firstCpuTick, frame.tickStartCpu) * global.tickToMsCpu,
                frameend: tickDiff(firstCpuTick, frame.tickEndCpu) * global.tickToMsCpu,
                framestartgpu: tickDiff(firstGpuTick, frame.tickStartGpu) * global.tickToMsGpu,
                frameendgpu: tickDiff(firstGpuTick, frame.tickEndGpu) * global.tickToMsGpu,
                paused: Boolean(frame.isPaused),
                incomplete: Boolean(frame.isIncomplete),
                cpuWaitTicks: 0,
                legacyJobsEndTick: 0,
                legacyRenderEndTick: 0,
                preRenderEndTick: 0,
                tt: threads.map(() => []),
                ts: threads.map(() => []),
                ti: threads.map(() => []),
                tl: threads.map(() => []),
            });
        }

        if (frames.length) {
            const iterator = session.CreateLogIterator();
            try {
                if (!iterator.Configure({
                    StartFrameId: frameIdMin,
                    EndFrameId: frameIdMax,
                    SkipFrameBoundaries: true,
                    SkipTimestampNormalization: true,
                    TrackScopeLabels: true,
                })) {
                    throw new Error("Unable to configure the LibMP log iterator");
                }
                const state = iterator.GetState();
                while (iterator.Step()) {
                    const frameIndex = frameIndexes.get(state.frameId());
                    const threadIndex = threadIndexes.get(state.threadId());
                    if (frameIndex === undefined || threadIndex === undefined)
                        continue;
                    const frame = frames[frameIndex];
                    appendLogEntry(
                        iterator, state, timerIndexes,
                        threads[threadIndex].isGpu ? firstGpuTick : firstCpuTick,
                        firstCpuTick,
                        {
                            tt: frame.tt[threadIndex],
                            ts: frame.ts[threadIndex],
                            ti: frame.ti[threadIndex],
                            tl: frame.tl[threadIndex],
                            frame,
                            eventTypesSeen,
                        });
                }
            } finally {
                iterator.Dispose();
            }
        }

        const counters = [];
        const counterIndexes = new Map();
        for (const id of session.FetchCounterIds()) {
            const counter = session.FetchCounterDesc(id);
            if (!counter)
                continue;
            const samples = session.FetchCounterSamples(id);
            const values = samples.map(sample => Number(sample.value));
            const value = values.length ? values[values.length - 1] : 0;
            let min = 0;
            let max = 0;
            if (values.length) {
                min = values[0];
                max = values[0];
                for (let index = 1; index < values.length; ++index) {
                    min = Math.min(min, values[index]);
                    max = Math.max(max, values[index]);
                }
            }
            counterIndexes.set(id, counters.length);
            counters.push({
                id: counters.length,
                sourceId: id,
                sourceParent: counter.parent,
                sourceSibling: counter.sibling,
                sourceFirstChild: counter.firstChild,
                level: counter.level,
                name: counter.counterName || "",
                value,
                min,
                max,
                samples,
                history: values.map(sample => sample - min),
            });
        }
        for (const counter of counters) {
            counter.parent = mapReference(counter.sourceParent, counterIndexes);
            counter.sibling = mapReference(counter.sourceSibling, counterIndexes);
            counter.firstChild = mapReference(counter.sourceFirstChild, counterIndexes);
            const pathParts = [counter.name];
            const visited = new Set([counter.sourceId]);
            let parentId = counter.sourceParent;
            while (parentId !== 0 && !visited.has(parentId)) {
                const parentIndex = counterIndexes.get(parentId);
                if (parentIndex === undefined)
                    break;
                const parent = counters[parentIndex];
                pathParts.push(parent.name);
                visited.add(parentId);
                parentId = parent.sourceParent;
            }
            counter.path = pathParts.reverse().join("/");
        }
        for (const counter of counters) {
            delete counter.sourceParent;
            delete counter.sourceSibling;
            delete counter.sourceFirstChild;
        }

        const counterByPath = new Map(counters.map(
            counter => [counter.path.toLowerCase(), counter]));
        function applyCounterSamples(path, applyValue) {
            const counter = counterByPath.get(path.toLowerCase());
            if (!counter)
                return;
            let sampleIndex = 0;
            let value = Number.NaN;
            for (const frame of frames) {
                while (sampleIndex < counter.samples.length &&
                    counter.samples[sampleIndex].frameId <= frame.sourceId) {
                    value = Number(counter.samples[sampleIndex].value);
                    sampleIndex++;
                }
                if (Number.isFinite(value))
                    applyValue(frame, value);
            }
        }
        applyCounterSamples("memory/total", (frame, value) => {
            frame.trackedMemoryMb = value / BYTES_PER_MEBIBYTE;
        });
        applyCounterSamples("memorygpu/total", (frame, value) => {
            frame.trackedGpuMemoryMb = value / BYTES_PER_MEBIBYTE;
        });
        applyCounterSamples("memory_aps/total", (frame, value) => {
            frame.allocationsPerSecond = value;
        });
        applyCounterSamples("memory_aps/numframes", (frame, value) => {
            frame.allocationRateFrameCount = value;
        });
        applyCounterSamples("memory_aps/numseconds", (frame, value) => {
            frame.allocationRateSeconds = value;
        });
        applyCounterSamples("frame_stats/basic/cpu_frequency_mhz", (frame, value) => {
            frame.cpuFrequency = value;
        });
        applyCounterSamples("frame_stats/basic/memory_used_bytes", (frame, value) => {
            frame.usedMemoryMb = value / BYTES_PER_MEBIBYTE;
        });
        applyCounterSamples("frame_stats/basic/memory_free_bytes", (frame, value) => {
            frame.freeMemoryMb = value / BYTES_PER_MEBIBYTE;
        });
        applyCounterSamples("frame_stats/basic/alloc_time_microsec", (frame, value) => {
            frame.allocationTimeMs = value / 1000;
        });
        applyCounterSamples("frame_stats/basic/alloc_count", (frame, value) => {
            frame.allocationCount = value;
        });
        applyCounterSamples("frame_stats/basic/free_time_microsec", (frame, value) => {
            frame.freeTimeMs = value / 1000;
        });
        applyCounterSamples("frame_stats/basic/free_count", (frame, value) => {
            frame.freeCount = value;
        });
        applyCounterSamples("frame_stats/basic/gpu_device_time_microsec", (frame, value) => {
            frame.driverGpuTimeMs = value / 1000;
        });
        for (const counter of counters)
            delete counter.samples;

        const statistics = calculateStatistics(
            frames, timers, groups, threads.map(thread => thread.isGpu),
            global.tickToMsCpu, global.tickToMsGpu);
        const general = session.FetchGeneralInfo();
        const placeSamples = session.FetchPlaceIdSamples();
        const utcSamples = session.FetchUtcTimestampSamples();
        const platformInfo = general?.platformInfoJson || "";
        let hasPlatformJson = false;
        try {
            JSON.parse(platformInfo);
            hasPlatformJson = platformInfo !== "";
        } catch (_) {
            // The viewer accepts the original text when this is not JSON.
        }

        const enabledFastFlags = [];
        if (hasPlatformJson)
            enabledFastFlags.push("MicroProfilerPlatformInfoJson");
        if (eventTypesSeen.has(EVENT_CPU_CORE_AND_FREQUENCY))
            enabledFastFlags.push("MicroprofilerPerFrameCpuSpeed");

        return {
            global,
            groups,
            timers,
            threads,
            counters,
            frames,
            threadGroupTimes: statistics.threadGroupTimes,
            wallTimeMode: statistics.wallTimeMode,
            platformInfo,
            placeId: placeSamples.length ? Number(placeSamples[placeSamples.length - 1].value) : 0,
            captureTime: utcSamples.length ? Number(utcSamples[utcSamples.length - 1].value) : 0,
            enabledFastFlags,
        };
    }

    function newFramegraphNode(timer, parent) {
        return {
            timerIndex: timer.timerIndex,
            name: timer.name,
            color: color(timer.color),
            groupName: timer.groupName,
            isDetailedTimer: timer.isDetailedTimer,
            parent,
            children: new Map(),
            cpuTicks: 0,
            allocCount: 0,
            allocSize: 0,
            entryCount: 0,
        };
    }

    function getFramegraphChild(children, timer, parent) {
        let node = children.get(timer.key);
        if (!node) {
            node = newFramegraphNode(timer, parent);
            children.set(timer.key, node);
        }
        return node;
    }

    function addBottomUpSample(roots, stack, exclusiveTicks) {
        if (exclusiveTicks <= 0 || stack[0]?.timer.name === "Sleep")
            return;
        let children = roots;
        let parent = null;
        for (let index = stack.length - 1; index >= 0; --index) {
            const timer = stack[index].timer;
            const node = getFramegraphChild(children, timer, parent);
            node.cpuTicks += exclusiveTicks;
            node.entryCount++;
            parent = node;
            children = node.children;
        }
    }

    function aggregateFramegraph(session) {
        const groupNames = new Map();
        for (let id = 1; id <= session.GetGroupIdMax(); ++id) {
            const group = session.FetchGroupDesc(id);
            if (group)
                groupNames.set(id, group.groupName || "");
        }

        const timers = new Map();
        let nextTimerIndex = 0;
        for (const sourceId of session.FetchTimerIds()) {
            const timer = session.FetchTimerDesc(sourceId);
            if (!timer)
                continue;
            timers.set(sourceId, {
                key: sourceId,
                sourceId,
                timerIndex: nextTimerIndex++,
                name: timer.timerName || "",
                color: timer.color,
                groupName: groupNames.get(timer.groupId) || "",
                isDetailedTimer: (timer.timerName || "").startsWith("Script_"),
            });
        }
        const labelTimers = new Map();
        function labelTimerFor(timer, label) {
            if (!timer?.name.startsWith("$") ||
                typeof label !== "string" || label.length === 0)
                return timer;
            let timersForSource = labelTimers.get(timer.sourceId);
            if (!timersForSource) {
                timersForSource = new Map();
                labelTimers.set(timer.sourceId, timersForSource);
            }
            let replacement = timersForSource.get(label);
            if (!replacement) {
                replacement = {
                    ...timer,
                    key: `label:${timer.sourceId}:${label}`,
                    timerIndex: nextTimerIndex++,
                    name: timer.name.endsWith("Overflow")
                        ? `*${label}`
                        : `${timer.name.slice(1)}_${label}`,
                    isDetailedTimer: true,
                };
                timersForSource.set(label, replacement);
            }
            return replacement;
        }

        const topDown = new Map();
        const bottomUp = new Map();
        const threadStates = new Map();
        function getThreadState(threadId) {
            let threadState = threadStates.get(threadId);
            if (!threadState) {
                threadState = { stack: [], allocCount: 0, allocSize: 0 };
                threadStates.set(threadId, threadState);
            }
            return threadState;
        }
        function materializeEntry(stack, index, useLabel, label) {
            const entry = stack[index];
            if (entry.node)
                return entry;
            if (index > 0)
                materializeEntry(stack, index - 1, false);
            if (useLabel)
                entry.timer = labelTimerFor(entry.timer, label);
            const parent = index > 0 ? stack[index - 1].node : null;
            entry.node = getFramegraphChild(
                parent ? parent.children : topDown, entry.timer, parent);
            return entry;
        }

        const frameIdMin = session.GetFrameIdMin();
        const frameIdMax = session.GetFrameIdMax();
        const iterator = session.CreateLogIterator();
        let lastFrameAbsoluteId = 0;
        try {
            if (!iterator.Configure({
                    StartFrameId: frameIdMin,
                    EndFrameId: frameIdMax,
                    SkipGpuThreads: true,
                    SkipFrameBoundaries: true,
                })) {
                throw new Error("Unable to configure the framegraph log iterator");
            }
            const iteratorState = iterator.GetState();
            while (iterator.Step()) {
                if (iteratorState.frameChanged()) {
                    const frameAbsoluteId = iteratorState.frameAbsoluteId();
                    if (lastFrameAbsoluteId > 0 && frameAbsoluteId !== lastFrameAbsoluteId + 1) {
                        for (const threadState of threadStates.values())
                            threadState.stack.length = 0;
                    }
                    lastFrameAbsoluteId = frameAbsoluteId;
                }

                const state = getThreadState(iteratorState.threadId());
                const stack = state.stack;
                if (iteratorState.isLabel()) {
                    if (stack.length) {
                        const top = stack[stack.length - 1];
                        materializeEntry(stack, stack.length - 1,
                            !top.node && top.timer.name.startsWith("$"),
                            iterator.FetchCurrentLabel());
                    }
                    continue;
                }
                if (iteratorState.isEvent()) {
                    if (stack.length)
                        materializeEntry(stack, stack.length - 1, false);
                    if (iteratorState.eventType() !== EVENT_MEM_SCOPE_STATS)
                        continue;
                    // LogIteratorState exposes the event type but not its payload.
                    // Read the packed words before advancing the iterator.
                    const words = getCurrentEntryWords(iterator);
                    if (!words?.length)
                        throw new Error("Unable to read a memory-scope event payload");
                    const counts = words[0] & EVENT_DATA_MASK;
                    state.allocCount += Number((counts >> 24n) & 0xffffffn);
                    if (words.length >= 3) {
                        const sizes = (words[1] & EVENT_DEPENDENT_DATA_MASK) |
                            ((words[2] & 0xffffffn) << 40n);
                        state.allocSize += Number((sizes >> 32n) & 0xffffffffn);
                    }
                    continue;
                }
                if (iteratorState.isEnter()) {
                    if (stack.length)
                        materializeEntry(stack, stack.length - 1, false);
                    const sourceTimerId = iteratorState.timerId();
                    const timer = timers.get(sourceTimerId);
                    if (!timer)
                        continue;
                    stack.push({
                        timer,
                        sourceTimerId,
                        node: null,
                        startTick: BigInt(iteratorState.timestamp()),
                        childTicks: 0n,
                        startAllocCount: state.allocCount,
                        startAllocSize: state.allocSize,
                    });
                    if (!timer.name.startsWith("$"))
                        materializeEntry(stack, stack.length - 1, false);
                    continue;
                }
                if (!iteratorState.isExit()) {
                    if (stack.length)
                        materializeEntry(stack, stack.length - 1, false);
                    continue;
                }

                const sourceTimerId = iteratorState.timerId();
                let match = stack.length - 1;
                while (match >= 0 && stack[match].sourceTimerId !== sourceTimerId)
                    match--;
                if (match < 0)
                    continue;
                if (match + 1 < stack.length)
                    stack.length = match + 1;
                const entry = materializeEntry(stack, match, false);
                const endTick = BigInt(iteratorState.timestamp());
                const inclusiveTicks = endTick >= entry.startTick
                    ? endTick - entry.startTick
                    : 0n;
                const exclusiveTicks = inclusiveTicks >= entry.childTicks
                    ? inclusiveTicks - entry.childTicks
                    : 0n;
                const inclusive = Number(inclusiveTicks);
                entry.node.cpuTicks += inclusive;
                entry.node.allocCount += Math.max(
                    0, state.allocCount - entry.startAllocCount);
                entry.node.allocSize += Math.max(
                    0, state.allocSize - entry.startAllocSize);
                entry.node.entryCount++;
                addBottomUpSample(bottomUp, stack, Number(exclusiveTicks));
                stack.pop();
                if (stack.length)
                    stack[stack.length - 1].childTicks += inclusiveTicks;
            }
        } finally {
            iterator.Dispose();
        }
        return { topDown, bottomUp };
    }

    function framegraphMetric(node, metric) {
        return metric === "cpuTicks"
            ? node.cpuTicks
            : metric === "allocCount"
            ? node.allocCount
            : node.allocSize;
    }

    function framegraphNodeToJson(node, metric, scale, parentValue, rootValue) {
        const displayValue = framegraphMetric(node, metric) * scale;
        const value = displayValue > parentValue ? parentValue * 0.8 : displayValue;
        const result = {
            name: node.name,
            displayValue,
            displayCount: node.entryCount,
            value,
            color: node.color,
            groupName: node.groupName,
            timerIndex: node.timerIndex,
            children: [],
        };
        const isSmallDetailedTimer = rootValue > 0 && value / rootValue <
            FRAMEGRAPH_DETAIL_THRESHOLD && node.isDetailedTimer;
        if (!isSmallDetailedTimer) {
            for (const child of node.children.values()) {
                result.children.push(framegraphNodeToJson(
                    child, metric, scale, value, rootValue));
            }
        }
        return result;
    }

    function framegraphTreeToJson(roots, metric, scale) {
        const visibleRoots = Array.from(roots.values()).filter(node => node.name !== "Sleep");
        const rootValue = visibleRoots.reduce(
            (sum, node) => sum + framegraphMetric(node, metric) * scale, 0);
        return {
            name: "root",
            displayValue: rootValue,
            displayCount: 1,
            value: rootValue,
            color: "#D3D3D3",
            groupName: "root",
            timerIndex: -1,
            children: visibleRoots.map(node =>
                framegraphNodeToJson(node, metric, scale, rootValue, rootValue)),
        };
    }

    function makeFramegraphDumpInfo(session, input, localId) {
        const frameIdMin = session.GetFrameIdMin();
        const frameIdMax = session.GetFrameIdMax();
        const placeSamples = session.FetchPlaceIdSamples();
        const utcSamples = session.FetchUtcTimestampSamples();
        return {
            fileName: input.fileName || input.file?.name || "capture.x.html",
            localId,
            localGroupId: input.localGroupId || 0,
            numberOfFrames: frameIdMax > 0 && frameIdMax >= frameIdMin
                ? frameIdMax - frameIdMin + 1
                : 0,
            utcCaptureTime: utcSamples.length
                ? Number(utcSamples[utcSamples.length - 1].value)
                : 0,
            placeId: String(placeSamples.length
                ? Number(placeSamples[placeSamples.length - 1].value)
                : 0),
        };
    }

    function makeFramegraphContainer(
        title, shortName, units, dumpInfo, topDown, bottomUp) {
        const result = { title, shortName, units, dumpInfo, topDown };
        if (bottomUp)
            result.bottomUp = bottomUp;
        return result;
    }

    function buildFramegraphContainers(session, input, localId, exportName) {
        const global = session.FetchGlobalDesc();
        if (!global)
            throw new Error("The capture has no global descriptor");
        const trees = aggregateFramegraph(session);
        const dumpInfo = makeFramegraphDumpInfo(session, input, localId);
        const cpuScale = global.tickToMsCpu;
        const includeCpu = exportName !== FRAMEGRAPH_EXPORT_MEM;
        const includeMemory = exportName !== FRAMEGRAPH_EXPORT_CPU;
        const result = [];
        if (includeCpu) {
            result.push(makeFramegraphContainer(
                "CPU time", "cpu_time", "ms", dumpInfo,
                framegraphTreeToJson(trees.topDown, "cpuTicks", cpuScale),
                exportName === FRAMEGRAPH_EXPORT_CPU
                    ? framegraphTreeToJson(trees.bottomUp, "cpuTicks", cpuScale)
                    : undefined));
        }
        if (includeMemory) {
            result.push(makeFramegraphContainer(
                "Memory allocations count", "mem_alloc_count", "", dumpInfo,
                framegraphTreeToJson(trees.topDown, "allocCount", 1)));
            result.push(makeFramegraphContainer(
                "Memory allocations size", "mem_alloc_size", "bytes", dumpInfo,
                framegraphTreeToJson(trees.topDown, "allocSize", 1)));
        }
        return result;
    }

    function isHtmlCapture(bytes) {
        return bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0x21 &&
            bytes[2] === 0x2d && bytes[3] === 0x2d;
    }

    async function captureBytesFromInput(input) {
        let bytes;
        if (input.isSelf) {
            bytes = await getCaptureBytes();
        } else if (input.captureBytes) {
            bytes = input.captureBytes instanceof Uint8Array
                ? input.captureBytes
                : new Uint8Array(input.captureBytes);
        } else if (input.file?.arrayBuffer) {
            bytes = new Uint8Array(await input.file.arrayBuffer());
        } else {
            throw new Error("Framegraph input has no capture data");
        }
        if (isHtmlCapture(bytes))
            bytes = captureFromHtmlBytes(bytes);
        return bytes;
    }

    function framegraphFileName() {
        if (options.inputPath)
            return String(options.inputPath).split(/[\\/]/).pop();
        if (typeof location !== "undefined" && location.pathname) {
            const part = location.pathname.split("/").pop();
            if (part)
                return decodeURIComponent(part);
        }
        return "capture.x.html";
    }

    function framegraphJsonForScript(value) {
        return JSON.stringify(value)
            .replace(/</g, "\\u003c")
            .replace(/\u2028/g, "\\u2028")
            .replace(/\u2029/g, "\\u2029");
    }

    function renderFramegraphHtml(containers) {
        const data = `const source_containers_json = ${framegraphJsonForScript(containers)};`;
        return FRAMEGRAPH_HTML_TEMPLATE.replace("//%DATA%", data);
    }

    async function ExportFramegraph(exportName, inputs) {
        const includeAllMetrics = exportName === FRAMEGRAPH_EXPORT_COMBO_DIFF;
        if (exportName !== FRAMEGRAPH_EXPORT_CPU &&
            exportName !== FRAMEGRAPH_EXPORT_MEM && !includeAllMetrics) {
            throw new Error(`Unknown framegraph exporter ${exportName}`);
        }
        const sourceInputs = inputs?.length
            ? inputs
            : [{ isSelf: true, fileName: framegraphFileName(), localGroupId: 0 }];
        const containers = [];
        const runtime = await getRuntime();
        for (let index = 0; index < sourceInputs.length; ++index) {
            const input = sourceInputs[index];
            const session = input.isSelf
                ? openCaptureSession(runtime, await getCaptureSource())
                : runtime.Session.OpenFromBuffer(await captureBytesFromInput(input));
            if (!session?.IsValid()) {
                throw new Error(
                    `Unable to open ${input.fileName || input.file?.name || "capture"}`);
            }
            selectInputSegment(session, input);
            const normalizedInput = {
                ...input,
                fileName: input.fileName || input.file?.name ||
                    (input.isSelf ? framegraphFileName() : `capture-${index}.gprx`),
            };
            try {
                containers.push(...buildFramegraphContainers(
                    session, normalizedInput, index, exportName));
            } finally {
                session.Dispose();
            }
        }
        return renderFramegraphHtml(containers);
    }

    function findAssetScript(name) {
        if (isNode() || typeof document === "undefined" ||
            typeof location === "undefined")
            return null;
        for (let index = document.scripts.length - 1; index >= 0; --index) {
            const script = document.scripts[index];
            if (script.getAttribute("data-libmp-asset")?.toLowerCase() === name)
                return script;
            if (!script.src)
                continue;
            const url = new URL(script.src, location.href);
            const pathName = url.pathname;
            const fileName = decodeURIComponent(
                pathName.substring(pathName.lastIndexOf("/") + 1));
            if (fileName.toLowerCase() === name)
                return script;
        }
        return null;
    }

    function findHostedAsset(name) {
        const script = findAssetScript(name);
        if (!script?.src)
            return null;
        const url = new URL(script.src, location.href);
        return url.protocol === "http:" || url.protocol === "https:"
            ? url.href
            : null;
    }

    function findHostedAssets() {
        const assets = Object.fromEntries(
            STANDALONE_ASSET_NAMES.map(name => [name, findHostedAsset(name)]));
        return STANDALONE_ASSET_NAMES.every(name => assets[name]) ? assets : null;
    }

    async function fetchStandaloneAssets() {
        const urls = findHostedAssets();
        if (!urls) {
            throw new Error(
                "Standalone export is available only when the viewer assets are web hosted");
        }

        const assets = {};
        for (const name of STANDALONE_ASSET_NAMES) {
            const response = await fetch(urls[name]);
            if (!response.ok)
                throw new Error(`Unable to fetch ${name}: HTTP ${response.status}`);
            assets[name] = await response.text();
        }
        return assets;
    }

    function renderCaptureHtml(capture, assetSections) {
        for (let index = 0; index < capture.length; ++index) {
            const code = capture.charCodeAt(index);
            if (code < 0x20 || code > 0x7e)
                throw new Error("HTML export requires an ASCII GPRX container");
        }

        return `<!--${capture}-->\n<!DOCTYPE html>\n<html>\n<head>\n` +
            `<meta charset="utf-8"><title>MicroProfiler Capture</title>\n` +
            `${assetSections}\n</head>\n</html>\n`;
    }

    function renderInlineAsset(name, source) {
        return `<script data-libmp-asset="${name}">\n` +
            `${source.replace(/<\/script/gi, "<\\/script")}\n</script>`;
    }

    function renderStandaloneHtml(capture, assets) {
        const assetSections = STANDALONE_ASSET_NAMES.map(name =>
            renderInlineAsset(name, assets[name])).join("\n");
        return renderCaptureHtml(capture, assetSections);
    }

    async function ExportStandaloneHtml() {
        const [capture, assets] = await Promise.all([
            getCaptureText(), fetchStandaloneAssets(),
        ]);
        return renderStandaloneHtml(capture, assets);
    }

    async function ExportLinkedHtml() {
        const assetSections = STANDALONE_ASSET_NAMES.map(name => {
            const script = findAssetScript(name);
            if (!script)
                throw new Error(`Unable to find the active ${name} asset`);
            if (script.src) {
                const url = new URL(script.src, location.href).href
                    .replace(/&/g, "&amp;")
                    .replace(/"/g, "&quot;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
                return `<script src="${url}"></script>`;
            }
            return renderInlineAsset(name, script.textContent || "");
        }).join("\n");
        return renderCaptureHtml(await getCaptureText(), assetSections);
    }

    async function ConvertCaptureToBuffer(input, format) {
        const normalizedInput = input?.arrayBuffer ? { file: input } : input;
        const runtime = await getRuntime();
        const source = normalizedInput?.isSelf
            ? await getCaptureSource()
            : { bytes: await captureBytesFromInput(normalizedInput) };
        const session = openCaptureSession(runtime, source);
        if (!session?.IsValid()) {
            throw new Error(
                `Unable to open ${normalizedInput?.fileName ||
                    normalizedInput?.file?.name || "capture"}`);
        }
        try {
            const selectedFormat = resolveContainerFormat(format, resolveLibMP());
            const result = runtime.Tools.ConvertToBuffer(session, selectedFormat.value);
            if (result === null)
                throw new Error("LibMP container conversion failed");
            return result;
        } finally {
            session.Dispose();
        }
    }

    function GetExportOptions() {
        return [
            ...(ENABLE_STANDALONE_EXPORT && findHostedAssets() ? [{
                funcName: STANDALONE_EXPORT,
                shortName: "",
                displayName: "Save for offline viewing",
                forceDownload: true,
            }] : []),
            {
                funcName: FRAMEGRAPH_EXPORT_COMBO_DIFF,
                shortName: "CompareDiff",
                displayName: "&#x26A1;Compare / Diff",
                comboDiff: true,
                hidden: true,
            },
            {
                funcName: FRAMEGRAPH_EXPORT_CPU,
                shortName: "FlamegraphCpu",
                displayName: "&#x1F525;CPU Flamegraph",
            },
            {
                funcName: FRAMEGRAPH_EXPORT_MEM,
                shortName: "FlamegraphMem",
                displayName: "&#x1F525;Memory Flamegraph",
                eventIdsNeeded: [EVENT_MEM_SCOPE_STATS],
            },
        ];
    }

    function framegraphInlineScript(html) {
        const tag = '<script type="text/javascript">';
        const start = html.indexOf(tag);
        const end = start < 0 ? -1 : html.indexOf("</script>", start + tag.length);
        if (start < 0 || end < 0)
            throw new Error("Framegraph HTML does not contain its processing script");
        return html.slice(start + tag.length, end);
    }

    function PrintFramegraphDiff(html, topCount, rules, writeLine) {
        if (!isNode())
            throw new Error("PrintFramegraphDiff is available only under Node.js");
        const vm = require("node:vm");
        const lines = [];
        const triggeredRules = [];
        const output = writeLine || (line => console.log(line));
        const context = {
            console: {
                log: (...values) => {
                    const line = values.map(String).join(" ");
                    lines.push(line);
                    output(line);
                },
                warn: (...values) => console.warn(...values),
                error: (...values) => console.error(...values),
                info: (...values) => console.info(...values),
            },
            cpp: {
                RuleTriggered: id => triggeredRules.push(Number(id)),
            },
            g_cliMode: true,
        };
        vm.createContext(context);
        vm.runInContext(framegraphInlineScript(html), context, {
            filename: "libmp-framegraph.html",
        });
        if (typeof context.ProcessContainers !== "function")
            throw new Error("Framegraph template does not expose ProcessContainers");
        context.ProcessContainers(topCount ?? 0, rules || []);
        return { lines, triggeredRules };
    }

    function defaultFramegraphOutput(inputPath) {
        if (/\.x\.html$/i.test(inputPath))
            return inputPath.replace(/\.x\.html$/i, ".framegraph.html");
        if (/\.gprx$/i.test(inputPath))
            return inputPath.replace(/\.gprx$/i, ".framegraph.html");
        return inputPath + ".framegraph.html";
    }

    function resolveContainerFormat(format, LibMP) {
        const formats = {
            raw: {
                value: LibMP.Enums.ContainerFormat.Raw,
                suffix: ".gprx",
                includeViewerAssets: false,
            },
            compressed: {
                value: LibMP.Enums.ContainerFormat.Compressed,
                suffix: ".gprx",
                includeViewerAssets: false,
            },
            "compressed-ascii": {
                value: LibMP.Enums.ContainerFormat.CompressedAscii,
                suffix: ".gprx",
                includeViewerAssets: false,
            },
            "compressed-html": {
                value: LibMP.Enums.ContainerFormat.CompressedHtml,
                suffix: ".x.html",
                includeViewerAssets: true,
            },
        };
        if (format === undefined || format === null || format === "")
            return formats["compressed-html"];
        if (typeof format === "number") {
            const selected = Object.values(formats).find(entry => entry.value === format);
            if (selected)
                return selected;
        } else {
            const selected = formats[String(format).toLowerCase()];
            if (selected)
                return selected;
        }
        throw new Error(
            "Unknown conversion format; expected raw, compressed, " +
            "compressed-ascii, or compressed-html");
    }

    function defaultConversionOutput(inputPath, format) {
        const base = inputPath.replace(/(?:\.x\.html|\.gprx)$/i, "");
        const destination = base + format.suffix;
        return destination.toLowerCase() === inputPath.toLowerCase()
            ? base + ".converted" + format.suffix
            : destination;
    }

    function printCliUsage() {
        console.error("usage:");
        console.error("  node tools.js --convert " +
            "[--format raw|compressed|compressed-ascii|compressed-html] " +
            "[--base-url <html-assets-base-url>] " +
            "<capture.gprx> [output]");
        console.error("  node tools.js --framegraph <capture.gprx|capture.x.html> [output.html]");
        console.error("  node tools.js --combo <capture...> --output <output.html> [--top N]");
        console.error("  node tools.js --diff --left <capture...> --right <capture...> " +
            "[--output <output.html>] [--top N] [--rule <rule>]...");
    }

    async function RunCli(argv) {
        const fs = require("node:fs");
        const path = require("node:path");
        if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
            printCliUsage();
            return argv.length ? 0 : 2;
        }

        const command = argv[0].toLowerCase();
        if (command === "--convert") {
            let format = "compressed-html";
            let htmlAssetsBaseUrl;
            const positional = [];
            for (let index = 1; index < argv.length; ++index) {
                const arg = argv[index];
                if (arg === "--format" && index + 1 < argv.length) {
                    format = argv[++index];
                } else if (arg.startsWith("--format=")) {
                    format = arg.slice("--format=".length);
                } else if (arg === "--base-url" && index + 1 < argv.length) {
                    htmlAssetsBaseUrl = argv[++index];
                } else if (arg.startsWith("--base-url=")) {
                    htmlAssetsBaseUrl = arg.slice("--base-url=".length);
                } else if (arg.startsWith("--")) {
                    throw new Error(`Unknown option ${arg}`);
                } else {
                    positional.push(arg);
                }
            }
            if (!positional.length || positional.length > 2) {
                printCliUsage();
                return 2;
            }
            const result = await ConvertFile(
                positional[0], positional[1], format, htmlAssetsBaseUrl);
            console.log(result);
            return 0;
        }
        if (command === "--framegraph") {
            if (!argv[1]) {
                printCliUsage();
                return 2;
            }
            const inputPath = argv[1];
            const outputPath = argv[2] || defaultFramegraphOutput(inputPath);
            const html = await ExportFramegraph(FRAMEGRAPH_EXPORT_CPU, [{
                captureBytes: fs.readFileSync(inputPath),
                fileName: path.basename(inputPath),
                localGroupId: 0,
            }]);
            fs.writeFileSync(outputPath, html);
            console.log(outputPath);
            return 0;
        }

        if (command !== "--combo" && command !== "--diff" &&
            command !== "--compare") {
            printCliUsage();
            return 2;
        }

        let groupId = 0;
        let outputPath = "";
        let topCount;
        const rules = [];
        const inputs = [];
        for (let index = 1; index < argv.length; ++index) {
            const arg = argv[index];
            if (arg === "--left") {
                groupId = 0;
            } else if (arg === "--right") {
                groupId = 1;
            } else if (arg === "--output" && index + 1 < argv.length) {
                outputPath = argv[++index];
            } else if (arg === "--top" && index + 1 < argv.length) {
                topCount = Number(argv[++index]);
                if (!Number.isInteger(topCount) || topCount < 0)
                    throw new Error("--top must be a non-negative integer");
            } else if ((arg === "--rule" || arg === "--rules") &&
                index + 1 < argv.length) {
                rules.push(argv[++index]);
            } else if (arg.startsWith("--")) {
                throw new Error(`Unknown option ${arg}`);
            } else {
                inputs.push({ path: arg, localGroupId: groupId });
            }
        }
        if (!inputs.length ||
            ((command === "--diff" || command === "--compare") &&
                (!inputs.some(input => input.localGroupId === 0) ||
                    !inputs.some(input => input.localGroupId === 1)))) {
            printCliUsage();
            return 2;
        }
        if (!outputPath && topCount === undefined && !rules.length) {
            printCliUsage();
            return 2;
        }

        const descriptors = inputs.map(input => ({
            captureBytes: fs.readFileSync(input.path),
            fileName: path.basename(input.path),
            localGroupId: command === "--combo" ? 0 : input.localGroupId,
        }));
        const html = await ExportFramegraph(FRAMEGRAPH_EXPORT_COMBO_DIFF, descriptors);
        if (outputPath) {
            fs.writeFileSync(outputPath, html);
            console.log(outputPath);
        }
        if (topCount !== undefined || rules.length) {
            const report = PrintFramegraphDiff(html, topCount ?? 0, rules);
            if (report.triggeredRules.length)
                return 100;
        }
        return 0;
    }

    function applyViewerModel(model, viewer) {
        const makeGroup = viewer.MakeGroup;
        const makeTimer = viewer.MakeTimer;
        const makeTimes = viewer.MakeTimes;
        const makeTimesType = viewer.MakeTimesType;
        const makeTimesExtra = viewer.MakeTimesExtra;
        const makeFrame = viewer.MakeFrame;
        const makeCounter = viewer.MakeCounter;
        for (const [name, fn] of Object.entries({
            MakeGroup: makeGroup,
            MakeTimer: makeTimer,
            MakeTimes: makeTimes,
            MakeTimesType: makeTimesType,
            MakeTimesExtra: makeTimesExtra,
            MakeFrame: makeFrame,
            MakeCounter: makeCounter,
        })) {
            if (typeof fn !== "function")
                throw new Error(`viewer.js did not provide ${name}`);
        }

        root.DumpHost = "";
        root.DumpUtcCaptureTime = model.captureTime;
        const captureDuration = model.frames.length
            ? model.frames[model.frames.length - 1].frameend - model.frames[0].framestart
            : 0;
        root.AggregateInfo = { Frames: model.frames.length, Time: captureDuration };
        root.PlatformInfo = model.platformInfo;
        root.GeneralInfo = { PlaceId: model.placeId, ContextLabel: "" };
        root.CategoryInfo = ["default"];
        root.GroupInfo = model.groups.map((group, index) => makeGroup(
            index, group.name, 0, group.timerCount, group.isGpu ? 1 : 0,
            group.total, group.average, group.max, color(group.color)));
        root.TimerInfo = model.timers.map((timer, index) => makeTimer(
            index, timer.name, timer.group, color(timer.color), darkColor(timer.color),
            timer.average, timer.max, timer.min, timer.exclaverage, timer.exclmax,
            timer.callaverage, timer.callcount, timer.total, [], [], []));
        root.ThreadNames = model.threads.map(thread => thread.name);
        root.ThreadIds = model.threads.map(thread => thread.id);
        root.ThreadGpu = model.threads.map(thread => thread.isGpu ? 1 : 0);
        root.ThreadClobbered = model.threads.map(thread => thread.clobbered ? 1 : 0);
        root.ThreadBufferSizes = model.threads.map(thread => thread.bufferSize);
        root.ThreadGroupTimeArray = model.threadGroupTimes.map(times => makeTimes(1, times));
        root.MetaNames = [];
        root.CounterInfo = model.counters.map(counter => makeCounter(
            counter.id, counter.parent, counter.sibling, counter.firstChild,
            counter.level, counter.name, counter.value, counter.min, counter.max,
            formatCounter(counter.value), 0, "0", 0, 0, 1, counter.history.slice()));
        root.Frames = model.frames.map((frame, index) => {
            const times = frame.ts.map((threadTimes, threadIndex) =>
                model.threads[threadIndex].isGpu
                    ? makeTimesExtra(
                        model.global.tickToMsGpu, model.global.tickToMsCpu,
                        frame.tt[threadIndex], threadTimes)
                    : makeTimesType(
                        model.global.tickToMsCpu,
                        frame.tt[threadIndex], threadTimes));
            const viewerFrame = makeFrame(
                index, frame.framestart, frame.frameend,
                frame.framestartgpu, frame.frameendgpu,
                times, frame.tt, frame.ti, frame.tl,
                frame.paused ? 1 : 0, frame.incomplete ? 1 : 0,
                frame.cpuFrequency ?? 0,
                frame.usedMemoryMb ?? frame.trackedMemoryMb ?? 0,
                frame.freeMemoryMb ?? 0,
                frame.allocationTimeMs ?? 0,
                frame.allocationCount ?? 0,
                frame.freeTimeMs ?? 0,
                frame.freeCount ?? 0,
                frame.cpuWaitsForGpu,
                frame.jobsWallTime,
                frame.renderWallTime,
                frame.driverGpuTimeMs ?? 0);
            viewerFrame.libmp_metrics = {
                wall_time_mode: model.wallTimeMode,
                wall_times_available: frame.wallTimesAvailable,
                memory_kind: Number.isFinite(frame.trackedMemoryMb)
                    ? "tracked-heap"
                    : "unavailable",
                gpu_memory_mb: frame.trackedGpuMemoryMb ?? Number.NaN,
                allocations_per_second:
                    frame.allocationsPerSecond ?? Number.NaN,
                allocation_rate_frame_count:
                    frame.allocationRateFrameCount ?? Number.NaN,
                allocation_rate_seconds:
                    frame.allocationRateSeconds ?? Number.NaN,
                external_gpu_time_available: Number.isFinite(frame.driverGpuTimeMs),
            };
            return viewerFrame;
        });
        root.ExtensionList = [];
        root.EnabledFastFlags = model.enabledFastFlags.slice();
        root.CGlobalLabels = [];
        root.CSwitchThreadInOutCpu = [];
        root.CSwitchTime = [];
        root.CSwitchThreads = {};
        root.S = {};
    }

    function selectedSegmentFromLocation(segmentCount) {
        if (typeof location === "undefined")
            return 0;
        const match = /(?:^#|[&#])segment=(\d+)/.exec(location.hash || "");
        const selected = match ? Number(match[1]) : 0;
        return Number.isInteger(selected) && selected >= 0 && selected < segmentCount
            ? selected
            : 0;
    }

    function selectInputSegment(session, input) {
        if (!session.GetTrackCount())
            return;
        const segmentCount = session.GetSegmentCount(0);
        if (!segmentCount)
            return;
        const segmentIndex = input.segmentIndex ??
            (input.isSelf ? selectedSegmentFromLocation(segmentCount) : 0);
        if (!Number.isInteger(segmentIndex) || segmentIndex < 0 ||
            segmentIndex >= segmentCount || !session.SelectTrack(0) ||
            !session.SelectSegment(segmentIndex)) {
            throw new Error(`Unable to select segment ${segmentIndex}`);
        }
    }

    const segmentMarkerPalette = ["#e44", "#4c4", "#48e", "#ec4", "#c5c"];

    function getSegmentMarkerColors(markers) {
        return segmentMarkerPalette.filter((_, index) => markers & (1 << index));
    }

    const segmentNavigationWidth = 176;
    const segmentNavigationRowHeight = 44;
    // Match the MicroProfiler viewer's default Reference time without loading unseen segments.
    const segmentFrameTimeScaleMs = 33;
    const segmentFrameTimeCounterPath = "frame_stats/basic/cpu_frame_time_microsec";
    const segmentTimestampIntervalMs = 15 * 1000;

    function formatSegmentElapsedTime(milliseconds, includeMilliseconds = false) {
        const elapsed = Math.max(0, Math.floor(Number(milliseconds) || 0));
        const totalSeconds = Math.floor(elapsed / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        const result = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
        return includeMilliseconds
            ? `${result}.${String(elapsed % 1000).padStart(3, "0")}`
            : result;
    }

    function addSegmentTimestampLabels(segments) {
        let previousBucket = -1;
        for (let index = 0; index < segments.length; ++index) {
            const segment = segments[index];
            const bucket = Math.floor(segment.elapsedStartMs / segmentTimestampIntervalMs);
            segment.timeLabel = index === 0 || bucket !== previousBucket
                ? formatSegmentElapsedTime(segment.elapsedStartMs)
                : "";
            previousBucket = bucket;
        }
    }

    function getCachedSegmentFrameTimes(segment) {
        const cached = segmentFrameTimeCache.get(segment.index);
        return cached &&
            cached.frameIdBegin === segment.frameIdBegin &&
            cached.frameIdEnd === segment.frameIdEnd &&
            cached.timestampStart === segment.timestampStart &&
            cached.timestampStop === segment.timestampStop
            ? cached.frameTimes
            : null;
    }

    function cacheSegmentFrameTimes(segment, frameTimes) {
        segmentFrameTimeCache.set(segment.index, {
            frameIdBegin: segment.frameIdBegin,
            frameIdEnd: segment.frameIdEnd,
            timestampStart: segment.timestampStart,
            timestampStop: segment.timestampStop,
            frameTimes,
        });
        return frameTimes;
    }

    function createSegmentFrameTimeSource(captureSource, runtime, segments) {
        let session = null;
        let disposed = false;
        return {
            load(index) {
                if (disposed)
                    throw new Error("Segment frame-time source was disposed");
                const descriptor = segments[index];
                if (!descriptor)
                    return [];
                session ||= openCaptureSession(runtime, captureSource);
                if (!session?.IsValid())
                    throw new Error("Unable to open segment frame-time data");
                if (!session.SelectTrack(0) || !session.SelectSegment(index))
                    throw new Error(`Unable to select segment ${index}`);
                const frameTimeCounterId = session.FindCounterId(segmentFrameTimeCounterPath);
                if (frameTimeCounterId) {
                    return session.FetchCounterSamples(frameTimeCounterId).map(sample =>
                        Math.max(0, Number(sample.value) / 1000));
                }
                const global = session.FetchGlobalDesc();
                if (!global)
                    return [];
                const frameTimes = [];
                for (let frameId = descriptor.frameIdBegin;
                    frameId <= descriptor.frameIdEnd; ++frameId) {
                    const frame = session.FetchFrameDesc(frameId);
                    if (frame) {
                        frameTimes.push(Math.max(0,
                            tickDiff(frame.tickStartCpu, frame.tickEndCpu) * global.tickToMsCpu));
                    }
                }
                return frameTimes;
            },
            dispose() {
                session?.Dispose();
                session = null;
                disposed = true;
            },
        };
    }

    function setSegmentNavigationInset(width) {
        if (!document.body)
            return;
        document.body.dataset.libmpViewerLeftInset = String(width);
        document.body.style.paddingLeft = `${width}px`;
        document.documentElement.style.setProperty(
            "--libmp-viewer-left-inset", `${width}px`);
        if (typeof root.dispatchEvent === "function" && typeof root.Event === "function")
            root.dispatchEvent(new root.Event("resize"));
    }

    function suspendSegmentNavigation() {
        if (typeof document === "undefined")
            return;
        const strip = document.getElementById("libmp-segment-strip");
        strip?._libmpCleanup?.();
        if (strip)
            strip._libmpCleanup = null;
    }

    function disposeSegmentNavigation() {
        if (typeof document === "undefined")
            return;
        const strip = document.getElementById("libmp-segment-strip");
        suspendSegmentNavigation();
        strip?.remove?.();
        setSegmentNavigationInset(0);
    }

    function renderSegmentNavigation(model) {
        if (typeof document === "undefined" || !document.body)
            return;
        let strip = document.getElementById("libmp-segment-strip");
        if (!model.segments || model.segments.length <= 1) {
            disposeSegmentNavigation();
            return;
        }
        if (!strip) {
            strip = document.createElement("div");
            strip.id = "libmp-segment-strip";
            document.body.appendChild(strip);
        }
        strip._libmpCleanup?.();
        Object.assign(strip.style, {
            position: "fixed", left: "0", top: "0", bottom: "0",
            width: `${segmentNavigationWidth}px`, height: "100vh",
            zIndex: "10000", display: "flex", flexDirection: "column",
            gap: "0", padding: "3px", overflowX: "hidden", overflowY: "auto",
            scrollbarGutter: "stable", background: "#171717", boxSizing: "border-box",
        });
        strip.replaceChildren();
        setSegmentNavigationInset(segmentNavigationWidth);

        let disposed = false;
        const states = [];
        const stateByLink = new Map();
        const drawState = state => {
            const { canvas, frameTimes, loaded, failed } = state;
            const context = canvas.getContext("2d");
            if (!context)
                return;
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#222";
            context.fillRect(0, 0, canvas.width, canvas.height);
            if (!loaded) {
                context.fillStyle = failed ? "#c66" : "#777";
                context.font = "10px monospace";
                context.fillText(failed ? "failed" : "loading...", 4, 17);
                return;
            }
            context.fillStyle = "#aaa";
            const width = canvas.width / Math.max(1, frameTimes.length);
            frameTimes.forEach((time, index) => {
                const height = Math.max(1,
                    Math.min(canvas.height, time / segmentFrameTimeScaleMs * canvas.height));
                context.fillRect(index * width, canvas.height - height,
                    Math.max(1, width), height);
            });
        };

        for (const segment of model.segments) {
            const link = document.createElement("a");
            link.href = `#segment=${segment.index}`;
            link.title = `Time ${formatSegmentElapsedTime(segment.elapsedStartMs, true)}-${
                formatSegmentElapsedTime(segment.elapsedEndMs, true)} since dump start`;
            link.setAttribute("aria-label", `Open segment ${segment.index + 1}, ${link.title}`);
            Object.assign(link.style, {
                display: "block", flex: `0 0 ${segmentNavigationRowHeight}px`,
                width: "100%", height: `${segmentNavigationRowHeight}px`,
                border: segment.index === model.selectedSegment
                    ? "2px solid white"
                    : "1px solid #666",
                boxSizing: "border-box", background: "#222", padding: "0",
                float: "none", position: "relative", overflow: "hidden",
            });
            link.onclick = event => {
                event.preventDefault();
                if (typeof root.LibMPViewer?.ReloadSegment === "function") {
                    root.LibMPViewer.ReloadSegment(segment.index).catch(error => {
                        console.error(`Unable to open segment ${segment.index}:`, error);
                    });
                    return;
                }
                location.hash = `segment=${segment.index}`;
                location.reload();
            };

            const markerLanes = document.createElement("span");
            markerLanes.setAttribute("aria-hidden", "true");
            Object.assign(markerLanes.style, {
                position: "absolute", left: "2px", top: "1px", bottom: "1px",
                width: "13px", display: "flex", gap: "1px",
            });
            for (let marker = 0; marker < segmentMarkerPalette.length; ++marker) {
                const lane = document.createElement("span");
                Object.assign(lane.style, {
                    display: "block", flex: "1 1 0",
                    background: segment.markers & (1 << marker)
                        ? segmentMarkerPalette[marker]
                        : "#292929",
                });
                markerLanes.appendChild(lane);
            }
            link.appendChild(markerLanes);

            const canvas = document.createElement("canvas");
            canvas.width = 136;
            canvas.height = 30;
            Object.assign(canvas.style, {
                position: "absolute", left: "16px", top: "1px",
                width: "136px", height: "30px",
            });
            link.appendChild(canvas);

            const timeLabel = document.createElement("span");
            timeLabel.textContent = segment.timeLabel;
            Object.assign(timeLabel.style, {
                position: "absolute", left: "18px", right: "2px", bottom: "0",
                height: "11px", color: "#bbb", font: "9px monospace",
                lineHeight: "11px", textAlign: "left", pointerEvents: "none",
            });
            link.appendChild(timeLabel);
            strip.appendChild(link);

            const frameTimes = Array.isArray(segment.frameTimes)
                ? segment.frameTimes
                : [];
            const state = {
                segment, link, canvas, frameTimes,
                loaded: Array.isArray(segment.frameTimes), loading: false, failed: false,
            };
            states.push(state);
            stateByLink.set(link, state);
        }

        for (const state of states)
            drawState(state);

        const loadState = state => {
            if (disposed || state.loaded || state.loading)
                return;
            state.loading = true;
            drawState(state);
            Promise.resolve().then(() => disposed
                ? null
                : model.loadSegmentFrameTimes(state.segment.index)).then(frameTimes => {
                if (disposed)
                    return;
                state.frameTimes = frameTimes;
                state.segment.frameTimes = frameTimes;
                state.loaded = true;
                state.loading = false;
                drawState(state);
            }).catch(error => {
                if (disposed)
                    return;
                state.loading = false;
                state.failed = true;
                drawState(state);
                console.error(`Unable to load frame times for segment ${state.segment.index}:`, error);
            });
        };

        const selectedState = states.find(state =>
            state.segment.index === model.selectedSegment);
        if (selectedState) {
            strip.scrollTop = Math.max(0,
                selectedState.link.offsetTop -
                (strip.clientHeight - selectedState.link.offsetHeight) / 2);
        }

        if (typeof root.IntersectionObserver === "function") {
            const observer = new root.IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (!entry.isIntersecting)
                        continue;
                    observer.unobserve(entry.target);
                    const state = stateByLink.get(entry.target);
                    if (state)
                        loadState(state);
                }
            }, { root: strip, threshold: 0 });
            for (const state of states) {
                if (!state.loaded)
                    observer.observe(state.link);
            }
            strip._libmpCleanup = () => {
                disposed = true;
                observer.disconnect();
            };
        } else {
            const loadVisibleStates = () => {
                const stripRect = strip.getBoundingClientRect();
                for (const state of states) {
                    const rect = state.link.getBoundingClientRect();
                    if (rect.bottom > stripRect.top && rect.top < stripRect.bottom)
                        loadState(state);
                }
            };
            strip.addEventListener("scroll", loadVisibleStates);
            root.addEventListener?.("resize", loadVisibleStates);
            const animationFrame = root.requestAnimationFrame?.(loadVisibleStates);
            strip._libmpCleanup = () => {
                disposed = true;
                strip.removeEventListener("scroll", loadVisibleStates);
                root.removeEventListener?.("resize", loadVisibleStates);
                if (animationFrame !== undefined)
                    root.cancelAnimationFrame?.(animationFrame);
            };
        }
    }

    async function loadModel(requestedSegment = options.segmentIndex) {
        const [captureSource, runtime] = await Promise.all([
            getCaptureSource(), getRuntime(),
        ]);
        const session = openCaptureSession(runtime, captureSource);
        if (!session?.IsValid())
            throw new Error("Unable to open the embedded GPRX capture");
        try {
            const tracks = session.FetchTracks();
            const segments = tracks.length ? session.FetchSegments(0) : [];
            availableSegmentCount = Math.max(1, segments.length);
            const selectedSegment = requestedSegment === undefined
                ? selectedSegmentFromLocation(segments.length)
                : Number(requestedSegment);
            if (!Number.isInteger(selectedSegment) || selectedSegment < 0 ||
                (segments.length ? selectedSegment >= segments.length : selectedSegment !== 0)) {
                throw new Error(`Unable to select segment ${selectedSegment}`);
            }
            activeSegmentIndex = selectedSegment;
            const segmentModels = segments.map((descriptor, index) => ({
                index,
                frameIdBegin: descriptor.frameIdBegin,
                frameIdEnd: descriptor.frameIdEnd,
                markers: descriptor.markers,
                timestampStart: descriptor.timestampStart,
                timestampStop: descriptor.timestampStop,
                frameTimes: null,
            }));
            for (const segment of segmentModels)
                segment.frameTimes = getCachedSegmentFrameTimes(segment);
            if (segments.length) {
                session.SelectTrack(0);
                session.SelectSegment(selectedSegment);
            }
            const model = await buildViewerModel(session);
            const captureStartTick = BigInt(tracks[0]?.timestampStart ??
                segments[0]?.timestampStart ?? 0);
            for (const segment of segmentModels) {
                segment.elapsedStartMs = Math.max(0,
                    tickDiff(captureStartTick, segment.timestampStart) * model.global.tickToMsCpu);
                segment.elapsedEndMs = segment.timestampStop
                    ? Math.max(segment.elapsedStartMs,
                        tickDiff(captureStartTick, segment.timestampStop) * model.global.tickToMsCpu)
                    : segment.elapsedStartMs;
            }
            addSegmentTimestampLabels(segmentModels);
            if (segmentModels[selectedSegment] && model.frames.length) {
                // The main viewer already fetched the selected segment, which is scrolled into view.
                const segment = segmentModels[selectedSegment];
                segment.frameTimes = cacheSegmentFrameTimes(segment,
                    model.frames.map(frame => Math.max(0, frame.frameend - frame.framestart)));
            }

            activeSegmentFrameTimeSource?.dispose();
            const segmentFrameTimeSource = segments.length > 1
                ? createSegmentFrameTimeSource(captureSource, runtime, segments)
                : null;
            activeSegmentFrameTimeSource = segmentFrameTimeSource;
            model.segments = segmentModels;
            model.selectedSegment = selectedSegment;
            model.loadSegmentFrameTimes = index => {
                const segment = segmentModels[index];
                if (!segment)
                    return [];
                if (!Array.isArray(segment.frameTimes)) {
                    segment.frameTimes = cacheSegmentFrameTimes(
                        segment, segmentFrameTimeSource?.load(index) || []);
                }
                return segment.frameTimes;
            };
            return model;
        } finally {
            session.Dispose();
        }
    }

    async function InitDataImpl(viewer, shouldRenderSegmentNavigation = true) {
        modelPromise ||= loadModel();
        const model = await modelPromise;
        applyViewerModel(model, viewer || root);
        if (shouldRenderSegmentNavigation)
            renderSegmentNavigation(model);
        return model;
    }

    function resetLoadedModel(preserveSegmentNavigation = false) {
        if (preserveSegmentNavigation)
            suspendSegmentNavigation();
        else
            disposeSegmentNavigation();
        activeSegmentFrameTimeSource?.dispose();
        activeSegmentFrameTimeSource = null;
        activeSegmentIndex = 0;
        modelPromise = null;
    }

    function Configure(newOptions) {
        resetLoadedModel();
        segmentFrameTimeCache.clear();
        Object.assign(options, newOptions || {});
        availableSegmentCount = null;
        captureSourcePromise = null;
        captureBytesPromise = null;
    }

    function SelectSegment(segmentIndex) {
        segmentIndex = Number(segmentIndex);
        if (!Number.isInteger(segmentIndex) || segmentIndex < 0)
            throw new TypeError("segment index must be a non-negative integer");
        if (availableSegmentCount !== null && segmentIndex >= availableSegmentCount)
            throw new RangeError(`segment index ${segmentIndex} is out of range`);
        resetLoadedModel(true);
        options.segmentIndex = segmentIndex;
    }

    async function ConvertFile(inputPath, outputPath, format, htmlAssetsBaseUrl) {
        if (!isNode())
            throw new Error("ConvertFile is available only under Node.js");
        const fs = require("node:fs");
        const path = require("node:path");
        const LibMP = resolveLibMP();
        const selectedFormat = resolveContainerFormat(format, LibMP);
        const destination = outputPath || defaultConversionOutput(inputPath, selectedFormat);
        if (path.resolve(destination) === path.resolve(inputPath))
            throw new Error("Conversion output must differ from the input path");
        const libmp = await LibMP.create();
        if (htmlAssetsBaseUrl !== undefined &&
            !libmp.Tools.SetHtmlAssetsBaseUrl(htmlAssetsBaseUrl)) {
            throw new Error("Unable to set the HTML assets base URL");
        }
        const session = await libmp.Session.OpenFromFile(inputPath);
        if (!session?.IsValid())
            throw new Error(`Unable to open ${inputPath}`);
        let dataFormatVersion = 0;
        try {
            dataFormatVersion = session.GetDataFormatVersion();
            if (!await libmp.Tools.ConvertToFile(
                    session, selectedFormat.value, destination)) {
                throw new Error("LibMP container conversion failed");
            }
        } finally {
            session.Dispose();
        }

        if (selectedFormat.includeViewerAssets) {
            const versionDirectory =
                `${dataFormatVersion >>> 16}.${dataFormatVersion & 0xffff}`;
            const destinationDirectory = path.join(
                path.dirname(path.resolve(destination)), versionDirectory);
            fs.mkdirSync(destinationDirectory, { recursive: true });
            for (const asset of ["libmp.js", "tools.js", "viewer.js"]) {
                const source = path.join(__dirname, asset);
                const target = path.join(destinationDirectory, asset);
                if (path.resolve(source) !== path.resolve(target))
                    fs.copyFileSync(source, target);
            }
        }
        return destination;
    }

    const api = {
        BuildViewerModel: buildViewerModel,
        Configure,
        ConvertCaptureToBuffer,
        ConvertFile,
        ExportFramegraph,
        ExportLinkedHtml,
        ExportStandaloneHtml,
        FormatSegmentElapsedTime: formatSegmentElapsedTime,
        GetSegmentMarkerColors: getSegmentMarkerColors,
        GetSelectedSegmentIndex: () => activeSegmentIndex,
        GetExportOptions,
        InitDataImpl,
        PrintFramegraphDiff,
        RenderSegmentNavigation: renderSegmentNavigation,
        RenderFramegraphHtml: renderFramegraphHtml,
        RunCli,
        SelectSegment,
    };

    if (isNode() && typeof require !== "undefined" && require.main === module) {
        RunCli(process.argv.slice(2)).then(exitCode => {
            process.exitCode = exitCode;
        }).catch(error => {
            console.error(error?.stack || String(error));
            process.exitCode = 1;
        });
    }

    return api;
});
