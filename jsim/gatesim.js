//////////////////////////////////////////////////////////////////////////////
//
//  Gate-level simulation
//
//////////////////////////////////////////////////////////////////////////////

// Copyright (C) 2013 Massachusetts Institute of Technology
// Chris Terman

var gatesim = (function() {

    function dc_analysis(netlist, sweep1, sweep2, options) {
        throw "Sorry, no DC analysis with gate-level simulation";
    }

    function ac_analysis(netlist, fstart, fstop, ac_source_name,options) {
        throw "Sorry, no AC analysis with gate-level simulation";
    }

    // Transient analysis
    //   netlist: JSON description of the circuit
    //   tstop: stop time of simulation in seconds
    //   probe_names: optional list of node names to be checked during LTE calculations
    //   progress_callback(percent_complete,network,msg)
    //      function called periodically, return true to halt simulation
    //      until simulation is complete, network is undefined
    //      message is string reporting any hiccups in simulation
    // network object is returned so UI can access event history for each node
    function transient_analysis(netlist, tstop, probe_names, progress_callback, options) {
        if (netlist.length > 0 && tstop !== undefined) {
            var network = new Network(netlist, options);

            var progress = {};
            progress.update_interval = 250; // in milliseconds
            progress.finish = function(msg) {
                progress_callback(undefined, network, msg);
            };
            progress.stop_requested = false;
            progress.update = function(percent_complete) { // 0 - 100
                // invoke the callback which will return true if the
                // simulation should halt.
                if (progress_callback(percent_complete, undefined, undefined))
                    progress.stop_requested = true;
            };

            network.initialize(progress, tstop);
            try {
                network.simulate(new Date().getTime() + network.progress.update_interval);
            }
            catch (e) {
                if (typeof e == 'string') progress.finish(e);
                else throw e;
            }
        }
    }

    // return string describing timing results
    function timing_analysis(netlist,options,maxpaths) {
        if (maxpaths === undefined) maxpaths = 10;
        var network = new Network(netlist, options);

        var analysis;
        try {
            analysis = network.get_timing_info();
        } catch (e) {
            return "Oops, timing analysis failed:\n"+e;
        }

        var div_counter = 0;
        function describe_tpd(from,to,tpd,result) {
            if (tpd.length == 0) return result;

            result += '<p><hr><p>';
            result += 'Worst-case t<sub>PD</sub> from '+from+' to '+to+'\n';

            // sort by pd_sum, longest first
            tpd.sort(function(tinfo1,tinfo2){ return tinfo2.pd_sum - tinfo1.pd_sum; });
            for (var i = 0; i < maxpaths && i < tpd.length; i += 1) {
                tinfo = tpd[i];
                result += '<p>  t<sub>PD</sub> from '+tinfo.get_tpd_source().name+' to '+tinfo.name+' ('+(tinfo.pd_sum*1e9).toFixed(3)+'ns):';
                result += ' <button onclick="$(\'#detail'+div_counter+'\').toggle()">Details</button>\n<div id="detail'+div_counter+'" style="display:none;">';
                result += tinfo.describe_tpd();
                result += '<br></div>';
                div_counter += 1;
            }

            return result;
        }

        var result = '';
        var i,node,tinfo,tpd;

        // report timing constraints for each clock
        $.each(analysis.clocks,function (index,clk) {
            // collect timing info at each device controlled by clk
            var th_violations = [];
            tpd = [];
            $.each(clk.fanouts,function (index,device) {
                tinfo = device.get_clock_info(clk);
                if (tinfo !== undefined) {
                    var src = tinfo.get_tpd_source().node;
                    if (src == clk) tpd.push(tinfo);
                    if (!src.is_input() && tinfo.cd_sum < 0) th_violations.push(tinfo);
                }
            });

            // report clk->clk timing contraints
            result = describe_tpd(clk.name+'\u2191',clk.name+'\u2191',tpd,result);

            // report hold-time violations, if any
            if (th_violations.length > 0) {
                result += '<p><hr><p>';
                result += 'Hold-time violations for '+clk.name+'\u2191:\n';
                $.each(th_violations,function (index,tinfo) {
                    result += '\n  tCD from '+tinfo.get_tcd_source().name+" to "+tinfo.cd_link.name+" violates hold time by "+(tinfo.cd_sum*1e9).toFixed(3)+"ns:\n";
                    result += tinfo.describe_tcd();
                });
            }

            // get tPDs from clk to top-level outputs
            tpd = [];
            $.each(analysis.timing,function (node,tinfo) {
                // only interested in top-level outputs
                if (tinfo.get_tpd_source().node == clk && tinfo.node.is_output())
                    tpd.push(tinfo);
            });
            result = describe_tpd(clk.name+'\u2191','top-level outputs',tpd,result);
        });

        // report worst-case combinational paths from inputs to top-level outputs
        tpd = [];
        $.each(analysis.timing,function (node,tinfo) {
            // only interested in top-level outputs
            if (tinfo.node.is_output() && !tinfo.get_tpd_source().node.clock)
                tpd.push(tinfo);
        });
        result = describe_tpd('inputs','top-level outputs',tpd,result);

        return result;
    }

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Network
    //
    //////////////////////////////////////////////////////////////////////////////

    function Network(netlist, options) {
        this.N = 0;
        this.node_map = {};
        this.aliases = {};
        this.nodes = [];
        this.devices = []; // list of devices
        this.device_map = {}; // name -> device
        this.event_queue = new Heap();
        this.options = options;
        this.debug_level = options.debug || 0;

        if (netlist !== undefined) this.load_netlist(netlist, options);
    }

    // return Node object for specified name, create if necessary
    Network.prototype.node = function(name) {
        // resolve name to canonical name
        while (this.aliases[name] !== undefined) name = this.aliases[name];
        // find Node in node_map or create a new Node
        var n = this.node_map[name];
        if (n === undefined) {
            n = new Node(name, this);
            this.node_map[name] = n;
            this.nodes.push(n);
            this.N += 1;
        }
        return n;
    };

    // load circuit from JSON netlist: [[device,[connections,...],{prop: value,...}]...]
    Network.prototype.load_netlist = function(netlist, options) {
        var network = this;
        network.N = 0;
        network.node_map = {};
        network.aliases = {};
        network.nodes = [];
        network.devices = []; // list of devices
        network.device_map = {}; // name -> device
        network.size = 0;

        // handle all the ground connections
        network.gnd = network.node('gnd');
        network.devices.push(new Source(network, 'gnd', network.gnd, {name: 'gnd', value: {type: 'dc', args: []}}));
        $.each(netlist,function (i,component) {
	    if (component.type == 'ground') {
		network.node_map[component.connections.gnd] = network.gnd;
	    }
        });

        // "connect a b ..." makes a, b, ... aliases for the same node
        $.each(netlist,function (i,component) {
            var c;
            if (component.type == 'connect') {
                var connections = component.connections;
                if (connections.length <= 1) return;
		// see if any of the connected nodes is a ground node.
		// if so, make it the canonical name. Otherwise just choose
		// connections[0] as the canonical name.
                var cname = connections[0];
                for (var j = 1; j < connections.length; j += 1) {
                    c = connections[j];
		    if (network.node_map[c] !== undefined) {
			cname = c;
			break;
		    }
		}
                while (network.aliases[cname] !== undefined) cname = network.aliases[cname];  // follow alias chain
		// so make all the other connected nodes aliases for the canonical name
                for (j = 1; j < connections.length; j += 1) {
                    c = connections[j];
                    while (network.aliases[c] !== undefined) c = network.aliases[c];  // follow alias chain
                    network.aliases[c] = cname;
                }
            }
        });

        // process each component in the JSON netlist (see schematic.js for format)
        var counts = {};
        $.each(netlist,function (i,component) {
            var n,d;
            var type = component.type;
            var connections = component.connections;
            var properties = component.properties;
            counts[type] = (counts[type] || 0) + 1;

            var name = properties.name;

            // convert node names to Nodes
            for (var c in connections) connections[c] = network.node(connections[c]);

            // process the component
            if (type in logic_gates) {
                var info = logic_gates[type]; // [input-list,output,table]
                // build input and output lists using terminal names in info array
                var inputs = [];
                $.each(info[0],function (j,cname) { inputs.push(connections[cname]); });
                // create a new device
                d = new LogicGate(network, type, name, info[2], inputs, connections[info[1]], properties);
                network.devices.push(d);
                network.device_map[name] = d;
            }
            else if (type == 'dreg' || type == 'dlatch' || type == 'dlatchn') {
                d = new Storage(network, name, type, connections, properties);
                network.devices.push(d);
                network.device_map[name] = d;
            }
            else if (type == 'memory') {
                // convert node names to Nodes
                $.each(properties.ports, function (i, port) {
                    $.each(port.addr, function (j,name) { port.addr[j] = network.node(name); });
                    $.each(port.data, function (j,name) { port.data[j] = network.node(name); });
                    port.clk = network.node(port.clk);
                    port.wen = network.node(port.wen);
                    port.oe = network.node(port.oe);
                });

                d = new Memory(network, name, properties, options);
                network.devices.push(d);
                network.device_map[name] = d;
            }
            else if (type == 'connect') {
                // handled above
            }
            else if (type == 'ground') {
                // handled above
            }
            else if (type == 'constant0' || type == 'constant1') {
                n = connections.z;
                if (n.drivers.length > 0) return; // already handled this one
                n.v = (type == 'constant0' ? V0 : V1);   // should be set by initialization of LogicGate that drives this node
                network.devices.push(new LogicGate(network, type, name, type == 'constant0' ? LTable:HTable, [], n, properties));
            }
            else if (type == 'voltage source') {
                n = connections.nplus; // hmmm.
                if (n.drivers.length > 0) return; // already handled this one
                network.devices.push(new Source(network, name,  n, properties));
            }
            else throw 'Unrecognized gate: ' + type;
        });

        // give each Node a chance to finalize itself
        $.each(network.node_map, function (n,node) { node.finalize(); });

        var msg = network.N.toString() + ' nodes';
        for (d in counts) msg += ', ' + counts[d].toString() + ' ' + d;
        console.log(msg);
    };

    // initialize for simulation, queue initial events
    Network.prototype.initialize = function(progress, tstop) {
        this.progress = progress;
        this.tstop = tstop;
        this.event_queue.clear();
        this.time = 0;

        // initialize nodes
        var i;
        for (i = 0; i < this.nodes.length; i += 1) this.nodes[i].initialize();

        // queue initial events
        for (i = 0; i < this.devices.length; i += 1) this.devices[i].initialize();
    };

    // tupdate is the wall-clock time at which we should take a quick coffee break
    // to let the UI update
    Network.prototype.simulate = function(tupdate) {
        var ecount = 0;
        if (!this.progress.stop_requested) { // halt when user clicks stop
            while (this.time < this.tstop && !this.event_queue.empty()) {
                var event = this.event_queue.pop();
                this.time = event.time;
                event.node.process_event(event, false);

                // check for coffee break every 1000 events
                if (++ecount < 1000) continue;
                else ecount = 0;

                var t = new Date().getTime();
                if (t >= tupdate) {
                    // update progress bar
                    var completed = Math.round(100 * this.time / this.tstop);
                    this.progress.update(completed);

                    // a brief break in the action to allow progress bar to update
                    // then pick up where we left off
                    var nl = this;
                    setTimeout(function() {
                        try {
                            nl.simulate(t + nl.progress.update_interval);
                        }
                        catch (e) {
                            if (typeof e == 'string') nl.progress.finish(e);
                            else throw e;
                        }
                    }, 1);

                    // our portion of the work is done
                    return;
                }
            }
            this.time = this.tstop;
        }

        // simulation complete or interrupted
        this.progress.finish(undefined);
    };

    Network.prototype.add_event = function(t, type, node, v) {
        var event = new Event(t, type, node, v);
        this.event_queue.push(event);
        if (this.debug_level > 2) console.log("add "+"cp"[type]+" event: "+node.name+"->"+"01XZ"[v]+" @ "+t);
        return event;
    };

    Network.prototype.remove_event = function(event) {
        this.event_queue.removeItem(event);
        if (this.debug_level > 2) console.log("remove "+"cp"[event.type]+" event: "+event.node.name+"->"+"01XZ"[event.v]+" @ "+event.time);
    };
    
    // return {xvalues: array, yvalues: array}, undefined if node has no events.
    // yvalues are 0, 1, 2=X, 3=Z
    Network.prototype.history = function(node) {
        while (this.aliases[node] !== undefined) node = this.aliases[node];
        var n = this.node_map[node];
        if (n === undefined) return undefined;
        var result = {xvalues: n.times,
                      yvalues: n.values.map(function (v) { return v % 4; })
                     };
        result.xvalues.push(this.time);  // record node's final value
        result.yvalues.push(n.v);
        return result;
    };

    Network.prototype.result_type = function() { return 'digital'; };

    Network.prototype.node_list = function() {
        var nlist = [];
        for (var n in this.node_map) nlist.push(n);
        return nlist;
    };

    // run a timing analysis for the network
    Network.prototype.get_timing_info = function() {
        var clocks = [];
        var timing = {};

        $.each(this.node_map,function (node,n) {
            if (n.clock) clocks.push(n);
            timing[node] = n.get_timing_info();
        });

        return {clocks: clocks, timing: timing};
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Events & the event heap
    //
    //////////////////////////////////////////////////////////////////////////////

    var CONTAMINATE = 0; // values chosen so that C events sort before P events
    var PROPAGATE = 1;

    function Event(t, type, node, v) {
        this.time = t; // time of event
        this.type = type; // CONTAMINATE, PROPAGATE
        this.node = node;
        this.v = v;
    }

    // Heaps are arrays for which a[k] <= a[2*k+1] and a[k] <=
    // a[2*k+2] for all k, counting elements from 0.  For the sake
    // of comparison, non-existing elements are considered to be
    // infinite.  The interesting property of a heap is that a[0]
    // is always its smallest element.
    // stolen from Python's heapq.py
    function Heap() {
        this.nodes = [];
    }

    // specialized for events...
    Heap.prototype.cmplt = function(e1, e2) {
        return e1.time < e2.time;
    };

    // 'heap' is a heap at all indices >= startpos, except possibly for pos.  pos
    // is the index of a leaf with a possibly out-of-order value.  Restore the
    // heap invariant.
    Heap.prototype._siftdown = function(startpos, pos) {
        var newitem, parent, parentpos;
        newitem = this.nodes[pos];
        // follow th epath to the root
        while (pos > startpos) {
            parentpos = (pos - 1) >> 1;
            parent = this.nodes[parentpos];
            if (this.cmplt(newitem, parent)) {
                this.nodes[pos] = parent;
                pos = parentpos;
                continue;
            }
            break;
        }
        this.nodes[pos] = newitem;
    };

    // The child indices of heap index pos are already heaps, and we want to make
    // a heap at index pos too.  We do this by bubbling the smaller child of
    // pos up (and so on with that child's children, etc) until hitting a leaf,
    // then using _siftdown to move the oddball originally at index pos into place.
    Heap.prototype._siftup = function(pos) {
        var childpos, endpos, newitem, rightpos, startpos;
        endpos = this.nodes.length;
        startpos = pos;
        newitem = this.nodes[pos];
        // bubble up the smaller child until hitting a leaf
        childpos = 2 * pos + 1;
        while (childpos < endpos) {
            // set childpos to index of smaller child
            rightpos = childpos + 1;
            if (rightpos < endpos && !(this.cmplt(this.nodes[childpos], this.nodes[rightpos]))) {
                childpos = rightpos;
            }
            // move the smaller child up
            this.nodes[pos] = this.nodes[childpos];
            pos = childpos;
            childpos = 2 * pos + 1;
        }
        // the leaf at pos is empty now.  Put newitem there and bubble it up
        // to its final resitng place (by sifting its parents down)
        this.nodes[pos] = newitem;
        this._siftdown(startpos, pos);
    };

    // add new item to the heap
    Heap.prototype.push = function(item) {
        this.nodes.push(item);
        this._siftdown(0, this.nodes.length - 1);
    };

    // remove smallest item from the head
    Heap.prototype.pop = function() {
        var lastelt, returnitem;
        lastelt = this.nodes.pop();
        if (this.nodes.length) {
            returnitem = this.nodes[0];
            this.nodes[0] = lastelt;
            this._siftup(0);
        }
        else {
            returnitem = lastelt;
        }
        return returnitem;
    };

    // see what smallest item is without removing it
    Heap.prototype.peek = function() {
        return this.nodes[0];
    };

    // is item on the heap?
    Heap.prototype.contains = function(item) {
        return this.nodes.indexOf(item) !== -1;
    };

    // rebuild heap after changing an item in the heap
    Heap.prototype.updateItem = function(item) {
        var pos = this.nodes.indexOf(item);
        if (pos != -1) {
            this._siftdown(0, pos);
            this._siftup(pos);
        }
    };

    // remove an item from the head
    Heap.prototype.removeItem = function(item) {
        var pos = this.nodes.indexOf(item);
        if (pos != -1) {
            // replace item to be removed with last element of heap
            // then sift it up to where it belongs
            var lastelt = this.nodes.pop();
            if (item !== lastelt) {
                this.nodes[pos] = lastelt;
                this._siftup(pos);
            }
        }
    };

    // clear the heap
    Heap.prototype.clear = function() {
        return this.nodes = [];
    };

    // is the heap empty?
    Heap.prototype.empty = function() {
        return this.nodes.length === 0;
    };

    // how many items on the heap?
    Heap.prototype.size = function() {
        return this.nodes.length;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Node
    //
    //////////////////////////////////////////////////////////////////////////////

    var V0 = 0; // node values
    var V1 = 1;
    var VX = 2;
    var VZ = 3;

    var c_slope = 0; // F/terminal of interconnect capacitance
    var c_intercept = 0; // F of interconnect capacitance

    function Node(name, network) {
        this.name = name;
        this.network = network;

        this.drivers = []; // devices which want to control value of this node
        this.driver = undefined; // device which controls value of this node
        this.fanouts = []; // devices with this node as an input
        this.capacitance = 0; // nodal capacitance
    }

    Node.prototype.initialize = function() {
        this.v = VX;
        this.times = [0.0]; // history of events
        this.values = [VX];
        this.cd_event = undefined; // contamination delay event for this node
        this.pd_event = undefined; // propagation delay event for this node

        // for timing analysis
        this.clock = false; // is this node connected to clock input of state device
        this.timing_info = undefined; // min tCD, max tPD for this node
        this.in_progress = false; // flag to catch combinational cycles
    };

    Node.prototype.add_fanout = function(device) {
        if (this.fanouts.indexOf(device) == -1) this.fanouts.push(device);
    };

    Node.prototype.add_driver = function(device) {
        this.drivers.push(device);
    };

    Node.prototype.process_event = function(event, force) {
        // update event pointers
        if (event == this.cd_event) this.cd_event = undefined;
        else if (event == this.pd_event) this.pd_event = undefined;
        else console.log('unknown event!',this.name,this.network.time);

        if (this.v != event.v || force) {
            this.times.push(event.time);
            this.values.push(this.v*4 + event.v);   // remember both previous and new values

            if (this.network.debug_level > 0) console.log(this.name + ": " + "01XZ"[this.v] + "->" + "01XZ"[event.v] + " @ " + event.time + [" contamination"," propagation"][event.type]);

            this.v = event.v;

            // let fanouts know our value changed
            for (var i = this.fanouts.length - 1; i >= 0; i -= 1) {
                if (this.network.debug_level > 1) console.log ("Evaluating ("+"cp"[event.type]+") "+this.fanouts[i].name+" @ "+event.time);
                this.fanouts[i].process_event(event,this);
            }
        }
    };

    Node.prototype.last_event_time = function () {
        return this.times[this.times.length - 1];
    };

    Node.prototype.finalize = function() {
        if (this.drivers === undefined || this.driver !== undefined) return; // already finalized

        // if no explicit capacitance has been supplied, estimate
        // interconnect capacitance
        var ndrivers = this.drivers.length;
        var nfanouts = this.fanouts.length;
        if (ndrivers === 0 && nfanouts > 0) throw 'Node ' + this.name + ' is not connected to any output.';
        if (this.capacitance === 0) this.capacitance = c_intercept + c_slope * (ndrivers + nfanouts);

        // add capacitances from drivers and fanout connections
        var i,d;
        for (i = 0; i < ndrivers; i += 1)
            this.capacitance += this.drivers[i].capacitance(this);
        for (i = 0; i < nfanouts; i += 1)
            this.capacitance += this.fanouts[i].capacitance(this);

        // if there is only 1 driver and it's not a tristate output
        // then that device is the driver for this node
        if (ndrivers == 1) {
            d = this.drivers[0];
            if (!d.tristate(this)) {
                this.driver = d;
                this.drivers = undefined;
                return;
            }
        }

        // handle tristates and multiple drivers by adding a special BUS
        // device that computes value from all the drivers
        var inputs = [];
        for (i = 0; i < ndrivers; i += 1) {
            d = this.drivers[i];
            if (!d.tristate(this)) {
                // shorting together non-tristate outputs, so complain
                var msg = 'Node ' + this.name + ' connects to more than one non-tristate output.  See devices: \n';
                for (var j = 0; j < ndrivers; j += 1)
                    msg += this.drivers[j].name + '\n';
                throw msg;
            }
            // cons up a new node and have this device drive it
            var n = new Node(this.network, this.name + '%' + i.toString());
            n.capacitance = this.capacitance; // each driver has to drive all the capacitance
            inputs.push(n);
            d.change_output_node(this, n);
            n.driver = d;
        }

        // now add the BUS device to drive the current node
        this.driver = new LogicGate(this.network, 'BUS', this.name + '%bus', BusTable, inputs, this, {}, true);
        this.drivers = undefined; // finalization complete
        this.network.devices.push(this.driver);
    };

    // schedule contamination event for this node
    Node.prototype.c_event = function(tcd) {
        var t = this.network.time + tcd;

        // remove any pending propagation event that happens after tcd
        if (this.pd_event && this.pd_event.time >= t) {
            this.network.remove_event(this.pd_event);
            this.pd_event = undefined;
        }

        // if we've already scheduled a contamination event for an earlier
        // time, make the conservative assumption that node will become
        // contaminated at the earlier possible time, i.e., keep the
        // earlier of the two contamination events
        if (this.cd_event) {
            if (this.cd_event.time <= t) return;
            this.network.remove_event(this.cd_event);
        }

        this.cd_event = this.network.add_event(t, CONTAMINATE, this, VX);
    };

    // schedule propagation event for this node
    Node.prototype.p_event = function(tpd, v, drive, lenient) {
        var t = this.network.time + tpd + drive * this.capacitance;

        if (this.pd_event) {
            if (lenient && this.pd_event.v == v && t >= this.pd_event.time) return;
            this.network.remove_event(this.pd_event);
        }

        this.pd_event = this.network.add_event(t, PROPAGATE, this, v);
    };

    // for timing analyses
    Node.prototype.is_input = function () {
        return this.driver === undefined || this.driver instanceof Source;
    };

    Node.prototype.is_output = function () {
        return this.fanouts.length === 0 && this.driver !== undefined &&
            !(this.driver instanceof Source) && this.name.indexOf('.') == -1;
    };

    Node.prototype.get_timing_info = function() {
        if (this.timing_info === undefined) {
            if (this.is_input()) {
                this.timing_info = new TimingInfo(this.name,this);
            } else {
                if (this.in_progress)
                    throw "Combinational cycle detected:\n  "+this.name;
                try {
                    this.in_progress = true;
                    // recursively compute timing info for this node
                    this.timing_info = this.driver.get_timing_info(this);
                    this.in_progress = false;
                } catch (e) {
                    this.in_progress = false;
                    // add our name to the end of the combinational cycle enumeration
                    throw e + "\n  " + this.name;
                }
            }
        }
        return this.timing_info;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Sources
    //
    ///////////////////////////////////////////////////////////////////////////////

    function Source(network, name, output, properties) {
        this.network = network;
        this.name = name;
        this.output = output;

        this.vil = network.options.vil || 0.1;
        this.vih = network.options.vih || 0.9;

        var v = Parser.parse_source(properties.value);
        if (v.fun == 'sin') throw "Can't use sin() sources in gate-level simulation";

        if (v.fun == 'dc') {
            this.tvpairs = [0, v.args[0]];   // single t,v pair
            this.period = 0;
        } else {
            this.tvpairs = v.tvpairs;
            this.period = v.period;

            // for periodic source, construct two periods of tvpairs so that
            // it's easy to search for next transition when it's in the next
            // period.
            if (this.period !== 0) {
                this.tvpairs = this.tvpairs.slice(0);  // copy tv pairs
                for (var i = 0; i < v.tvpairs.length; i += 2) {
                    this.tvpairs.push(v.tvpairs[i] + this.period);  // time in the next period
                    this.tvpairs.push(v.tvpairs[i+1]);   // voltage
                }
            }
        }

        // figure out initial value from first t,v pair
        this.initial_value = this.tvpairs[1] <= this.vil ? V0 : (this.tvpairs[1] >= this.vih ? V1 : VX);

        output.add_fanout(this);    // listen for our own events!
        output.add_driver(this);
    }

    Source.prototype.initialize = function() {
        if (this.initial_value != VX)
            this.output.p_event(0,this.initial_value,0,false);
    };

    Source.prototype.capacitance = function(node) {
        return 0;
    };

    // is node a tristate output of this device?
    Source.prototype.tristate = function(node) {
        return false;
    };

    // figure out next event for source -- triggered by last event!
    Source.prototype.process_event = function(event,cause) {
        var time = this.network.time;
        var t,v;

        // propagate events on source's output cause new events
        // to be scheduled for *next* source transition
        if (event.type == PROPAGATE) {
            t = this.next_contamination_time(time);
            if (t >= 0) this.output.c_event(t - time);
            //console.log(this.output.name + ": "+(t * 1e9).toFixed(2) + ' -> contaminate');

            t = this.next_propagation_time(time);
            if (t.time > 0) this.output.p_event(t.time - time, t.value, 0, false);
            //console.log(this.output.name + ": "+(t.time * 1e9).toFixed(2) + ' -> ' + "01XZ"[t.value]);
        }
    };

    // return time of next contamination event for pwl source
    Source.prototype.next_contamination_time = function(xtime) {
        xtime += 1e-13;  // get past current time by epsilon

        // handle periodic sources
        var time = xtime;   // time we'll be searching for in tvpairs
        var tbase = 0;      // time at beginning of period
        if (this.period !== 0) {
            time = Math.fmod(time,this.period);
            tbase = xtime - time;
        }

        var tlast = 0;
        var vlast = 0;
        var npairs = this.tvpairs.length;
        var et;
        for (var i = 0; i < npairs; i += 2) {
            var t = this.tvpairs[i];
            var v = this.tvpairs[i+1];
            if (i > 0 && time <= t) {
                if (vlast >= this.vih && v < this.vih) {
                    et = tlast + (t - tlast)*(this.vih - vlast)/(v - vlast);
                    if (et > time) return tbase+et;
                }
                else if (vlast <= this.vil && v > this.vil) {
                    et = tlast + (t - tlast)*(this.vil - vlast)/(v - vlast);
                    if (et > time) return tbase+et;
                }
            }
            tlast = t;
            vlast = v;
        }
        return -1;
    };

    // return {time:t, value: v} of next propagation event for pwl source
    Source.prototype.next_propagation_time = function (xtime) {
        xtime += 1e-13;  // get past current time by epsilon

        // handle periodic sources
        var time = xtime;   // time we'll be searching for in tvpairs
        var tbase = 0;      // time at beginning of period
        if (this.period !== 0) {
            time = Math.fmod(time,this.period);
            tbase = xtime - time;
        }

        var tlast = 0;
        var vlast = 0;
        var npairs = this.tvpairs.length;
        var et;
        for (var i = 0; i < npairs; i += 2) {
            var t = this.tvpairs[i];
            var v = this.tvpairs[i+1];
            if (i > 0 && time <= t) {
                if (vlast < this.vih && v >= this.vih) {
                    et = tlast + (t - tlast)*(this.vih - vlast)/(v - vlast);
                    if (et > time) return {time: tbase+et, value: V1};
                }
                else if (vlast > this.vil && v <= this.vil) {
                    et = tlast + (t - tlast)*(this.vil - vlast)/(v - vlast);
                    if (et > time) return {time: tbase+et, value: V0};
                }
            }
            tlast = t;
            vlast = v;
        }
        return {time: -1};
    };

    Source.prototype.get_clock_info = function(clk) {
        return undefined;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Logic gates
    //
    ///////////////////////////////////////////////////////////////////////////////

    // it's tables all the way down
    // use current input as index into current table to get new table
    // repeat until all inputs have been consumed
    // final value is given by current_table[4]

    var LTable = [];
    LTable.push(LTable, LTable, LTable, LTable, 0); // always "0"
    var HTable = [];
    HTable.push(HTable, HTable, HTable, HTable, 1); // always "1"
    var XTable = [];
    XTable.push(XTable, XTable, XTable, XTable, 2); // always "X"
    var ZTable = [];
    ZTable.push(ZTable, ZTable, ZTable, ZTable, 3); // always "Z"
    var SelectTable = [LTable, HTable, XTable, XTable, 2]; // select this input
    var Select2ndTable = [SelectTable, SelectTable, SelectTable, SelectTable, 2]; // select second input
    var Select3rdTable = [Select2ndTable, Select2ndTable, Select2ndTable, Select2ndTable, 2]; // select third input
    var Select4thTable = [Select3rdTable, Select3rdTable, Select3rdTable, Select3rdTable, 2]; // select fourth input
    var Ensure0Table = [LTable, XTable, XTable, XTable, 2]; // must be 0
    var Ensure1Table = [XTable, HTable, XTable, XTable, 2]; // must be 1
    var EqualTable = [Ensure0Table, Ensure1Table, XTable, XTable, 2]; // this == next

    // tristate bus resolution
    // produces "Z" if all inputs are "Z"
    // produces "1" if one input is "1" and other inputs are "1" or "Z"
    // produces "0" if one input is "0" and other inputs are "0" or "Z"
    // produces "X" otherwise
    var BusTable = [];
    var Bus0Table = [];
    var Bus1Table = [];
    BusTable.push(Bus0Table, Bus1Table, XTable, BusTable, 3);
    Bus0Table.push(Bus0Table, XTable, XTable, Bus0Table, 0);
    Bus1Table.push(XTable, Bus1Table, XTable, Bus1Table, 1);

    // tristate buffer (node order: enable,in)
    var TristateBufferTable = [ZTable, SelectTable, XTable, XTable, 2];

    // and tables
    var AndXTable = [];
    AndXTable.push(LTable, AndXTable, AndXTable, AndXTable, 2);
    var AndTable = [];
    AndTable.push(LTable, AndTable, AndXTable, AndXTable, 1);

    // nand tables
    var NandXTable = [];
    NandXTable.push(HTable, NandXTable, NandXTable, NandXTable, 2);
    var NandTable = [];
    NandTable.push(HTable, NandTable, NandXTable, NandXTable, 0);

    // or tables
    var OrXTable = [];
    OrXTable.push(OrXTable, HTable, OrXTable, OrXTable, 2);
    var OrTable = [];
    OrTable.push(OrTable, HTable, OrXTable, OrXTable, 0);

    // nor tables
    var NorXTable = [];
    NorXTable.push(NorXTable, LTable, NorXTable, NorXTable, 2);
    var NorTable = [];
    NorTable.push(NorTable, LTable, NorXTable, NorXTable, 1);

    // xor tables
    var XorTable = [];
    var Xor1Table = [];
    XorTable.push(XorTable, Xor1Table, XTable, XTable, 0);
    Xor1Table.push(Xor1Table, XorTable, XTable, XTable, 1);
    var XnorTable = [];
    var Xnor1Table = [];
    XnorTable.push(XnorTable, Xnor1Table, XTable, XTable, 1);
    Xnor1Table.push(Xnor1Table, XnorTable, XTable, XTable, 0);

    // 2-input mux table (node order: sel,d0,d1)
    var Mux2Table = [SelectTable, Select2ndTable, EqualTable, EqualTable, 2];

    // 4-input mux table (node order: s0,s1,d0,d1,d2,d3)
    var Mux4aTable = [SelectTable, Select3rdTable, EqualTable, EqualTable, 2]; // s0 == 0
    var Mux4bTable = [Select2ndTable, Select4thTable, EqualTable, EqualTable, 2]; // s0 == 1
    var Mux4Table = [Mux4aTable, Mux4bTable, EqualTable, EqualTable, 2];

    // for each logic gate provide [input-terminal-list,output-terminal,table]
    var logic_gates = {
        'and2': [['a', 'b'], 'z', AndTable],
        'and3': [['a', 'b', 'c'], 'z', AndTable],
        'and4': [['a', 'b', 'c', 'd'], 'z', AndTable],
        'buffer': [['a'], 'z', AndTable],
        'inv': [['a'], 'z', NandTable],
        'mux2': [['s', 'd0', 'd1'], 'z', Mux2Table],
        'mux4': [['s0', 's1', 'd0', 'd1', 'd2', 'd3'], 'z', Mux4Table],
        'nand2': [['a', 'b'], 'z', NandTable],
        'nand3': [['a', 'b', 'c'], 'z', NandTable],
        'nand4': [['a', 'b', 'c', 'd'], 'z', NandTable],
        'nor2': [['a', 'b'], 'z', NorTable],
        'nor3': [['a', 'b', 'c'], 'z', NorTable],
        'nor4': [['a', 'b', 'c', 'd'], 'z', NorTable],
        'or2': [['a', 'b'], 'z', OrTable],
        'or3': [['a', 'b', 'c'], 'z', OrTable],
        'or4': [['a', 'b', 'c', 'd'], 'z', OrTable],
        'tristate': [['e', 'a'], 'z', TristateBufferTable],
        'xor2': [['a', 'b'], 'z', XorTable],
        'xnor2': [['a', 'b'], 'z', XnorTable]
    };

    function LogicGate(network, type, name, table, inputs, output, properties) {
        this.network = network;
        this.type = type;
        this.name = name;
        this.table = table;
        this.inputs = inputs;
        this.output = output;
        this.properties = properties;

        this.lenient = properties.lenient !== undefined && properties.lenient !== 0;
        this.cout = properties.cout || 0;
        this.cin = properties.cin || 0;
        this.tcd = properties.tcd || 0;
        this.tpdf = properties.tpdf || properties.tpd || 0;
        this.tpdr = properties.tpdr || properties.tpd || 0;
        this.tr = properties.tr || 0;
        this.tf = properties.tf || 0;

        if (this.properties.size !== undefined) network.size += this.properties.size;

        for (var i = 0; i < inputs.length ; i+= 1) inputs[i].add_fanout(this);
        output.add_driver(this);

        var in0 = inputs[0];
        var in1 = inputs[1];
        var in2 = inputs[2];
        var in3 = inputs[3];
        var in4 = inputs[4];
        var in5 = inputs[5];
        if (inputs.length === 0) this.logic_eval = function() {
            return table[4];
        };
        else if (inputs.length == 1) this.logic_eval = function() {
            return table[in0.v][4];
        };
        else if (inputs.length == 2) this.logic_eval = function() {
            return table[in0.v][in1.v][4];
        };
        else if (inputs.length == 3) this.logic_eval = function() {
            return table[in0.v][in1.v][in2.v][4];
        };
        else if (inputs.length == 4) this.logic_eval = function() {
            return table[in0.v][in1.v][in2.v][in3.v][4];
        };
        else if (inputs.length == 5) this.logic_eval = function() {
            return table[in0.v][in1.v][in2.v][in3.v][in4.v][4];
        };
        else if (inputs.length == 6) this.logic_eval = function() {
            return table[in0.v][in1.v][in2.v][in3.v][in4.v][in5.v][4];
        };
        else this.logic_eval = function() {
            // handles arbitrary numbers of inputs (eg, for BusTable).
            var t = table;
            for (var i = 0; i < inputs.length ; i+= 1) t = t[inputs[i].v];
            return t[4];
        };
    }

    LogicGate.prototype.initialize = function() {
        if (this.inputs.length === 0) {
            // gates with no inputs will produce a constant output, so
            // figure that out now and process the appropriate event
            var v = this.logic_eval();
            this.output.p_event(0,v,0,false);
        }
    };

    LogicGate.prototype.capacitance = function(node) {
        if (this.output == node) return this.cout;
        else return this.cin;
    };

    // is node a tristate output of this device?
    LogicGate.prototype.tristate = function(node) {
        if (this.output == node && this.table == TristateBufferTable) return true;
        else return false;
    };

    // evaluation of output values triggered by an event on the input
    LogicGate.prototype.process_event = function(event,cause) {
        var onode = this.output;
        var v;
        if (event.type == CONTAMINATE) {
            // a lenient gate won't contaminate the output under the right circumstances
            if (this.lenient) {
                v = this.logic_eval();
                if (onode.pd_event === undefined) {
                    // no events pending and current value is same as new value
                    if (onode.cd_event === undefined && v == onode.v) return;
                }
                else {
                    // node is destined to have the same value as new value
                    if (v == onode.pd_event.v) return;
                }
            }

            // schedule contamination event with specified delay
            onode.c_event(this.tcd);
        }
        else if (event.type == PROPAGATE) {
            v = this.logic_eval();
            if (!this.lenient || v != onode.v || onode.cd_event !== undefined || onode.pd_event !== undefined) {
                var drive, tpd;
                if (v == V1) {
                    tpd = this.tpdr;
                    drive = this.tr;
                }
                else if (v == V0) {
                    tpd = this.tpdf;
                    drive = this.tf;
                }
                else {
                    tpd = Math.min(this.tpdr, this.tpdf);
                    drive = 0;
                }
                onode.p_event(tpd, v, drive, this.lenient);
            }
        }
    };

    LogicGate.prototype.get_timing_info = function(output) {
        var tr = this.tpdr + this.tr*output.capacitance;
        var tf = this.tpdf + this.tf*output.capacitance;
        var tinfo = new TimingInfo(output.name,output,this,this.tcd,Math.max(tr,tf));

        // loop through inputs looking for min/max paths
        for (var i = 0; i < this.inputs.length ; i+= 1) {
            tinfo.set_delays(this.inputs[i].get_timing_info());
        }
        return tinfo;
    };

    LogicGate.prototype.get_clock_info = function(clk) {
        return undefined;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Storage elements: dreg, dlatch, dlatchn
    //
    ///////////////////////////////////////////////////////////////////////////////

    function Storage(network, name, type, connections, properties) {
        this.network = network;
        this.name = name;
        this.type = type;

        this.d = connections.d;
        this.clk = connections.clk;
        this.q = connections.q;

        this.d.add_fanout(this);
        this.clk.add_fanout(this);
        this.q.add_driver(this);

        // clk node gets special treatment during timing analysis
        if (type == 'dreg') this.clk.clock = true;

        this.gate_open = (type == 'dlatch') ? V1 : V0;   // when is latch open?
        this.gate_closed = (type == 'dlatch') ? V0 : V1;   // when is latch closed?

        this.properties = properties;
        this.lenient = properties.lenient !== undefined && properties.lenient !== 0;
        this.cout = properties.cout || 0;
        this.cin = properties.cin || 0;
        this.tcd = properties.tcd || 0;
        this.tpdf = properties.tpdf || properties.tpd || 0;
        this.tpdr = properties.tpdr || properties.tpd || 0;
        this.tr = properties.tr || 0;
        this.tf = properties.tf || 0;
        this.ts = properties.ts || 0;
        this.th = properties.th || 0;

        if (this.properties.size !== undefined) network.size += this.properties.size;
    }

    Storage.prototype.initialize = function() {
        this.min_setup = undefined;
        this.min_setup_time = undefined;
        this.state = VX;
    };

    Storage.prototype.capacitance = function(node) {
        if (this.q == node) return this.cout;
        else return this.cin;
    };

    // is node a tristate output of this device?
    Storage.prototype.tristate = function(node) { return false; };

    // evaluation of output values triggered by an event on the input
    Storage.prototype.process_event = function(event,cause) {
        if (this.type == 'dreg') {
            if (event.type != PROPAGATE) return;  // no contamination events allowed!

            // if CLK is 0, master latch (ie, state) follows D input
            if (this.clk.v == V0) this.state = this.d.v;
            // otherwise we only care about event if CLK is changing
            else if (this.clk == cause) {
                if (this.clk.v == V1) {  // rising clock edge!
                    // track minimum setup time we see
                    var now = this.network.time;
                    var d_time = this.d.last_event_time();
                    if (d_time !== undefined) {
                        if (now > 0) {
                            var tsetup = this.network.time - d_time;
                            if (this.min_setup === undefined || tsetup < this.min_setup) {
                                this.min_setup = tsetup;
                                this.min_setup_time = now;
                            }
                        }
                    }
                    // report setup time violations?

                    // for lenient dreg's, q output is propagated only
                    // when new output value differs from current one
                    if (!this.lenient || this.state != this.q.v)
                        this.q.c_event(this.tcd);

                    this.q.p_event((this.state == V0) ? this.tpdf : this.tpdr,
                                   this.state,
                                   (this.state == V0) ? this.tf : this.tr,
                                   this.lenient);
                } else {
                    // X on clock won't contaminate value in master if we're
                    // a lenient register and master == D
                    if (!this.lenient || this.state != this.d.v) this.state = VX;

                    // send along to Q if we're not lenient or if master != Q
                    if (!this.lenient || this.state != this.q.v)
                        this.q.p_event(Math.min(this.tpdf,this.tpdr),
                                       VX,0,this.lenient);
                }
            }
        } else {
            // compute output of latch
            var v = (this.g.v == this.gate_closed) ? this.state :
                    (this.g.v == this.gate_open) ? this.d.v :
                    (this.lenient && this.d.v == this.state) ? this.state : VX;

            // state follows D when gate is open
            if (this.g.v == this.gate_open) this.state = v;

            if (event.type == CONTAMINATE) {
                // a lenient latch sometimes won't contaminate output
                if (this.lenient) {
                    if (this.q.pd_event == undefined) {
                        // no events pending and current value is same as new value
                        if (this.q.cd_event == undefined && v == this.q.v) return;
                    } else {
                        // node is destined to have the same value as new value
                        if (v == this.q.pd_event.v) return;
                    }
                }
                // schedule contamination event with specified delay
                this.q.c_event(this.tcd);
            } else if (event.type == PROPAGATE) {
                // avoid scheduling PROPAGATE events if we can...
                if (!this.lenient || v != this.q.v || this.q.cd_event !== undefined || this.q.pd_event !== undefined) {
                    var drive,tpd;
                    if (v == V1) { tpd = this.tpdr; drive = this.tr; }
                    else if (v == V0) { tpd = this.tpdf; drive = this.tf; }
                    else { tpd = Math.min(this.tpdr,this.tpdf); drive = 0; }
                    this.q.p_event(tpd,v,drive,this.lenient);
                }
            }
        }
    };

    Storage.prototype.get_timing_info = function(output) {
        var tr = this.tpdr + this.tr*output.capacitance;
        var tf = this.tpdf + this.tf*output.capacitance;
        var tinfo = new TimingInfo(output.name,output,this,this.tcd,Math.max(tr,tf));

        var cinfo = $.extend({},this.clk.get_timing_info());  // make a copy
        cinfo.name = cinfo.name + '\u2191';  // add rising edge indicator to name
        tinfo.set_delays(cinfo);

        if (this.type != 'dreg') {
            // latch timing also depends on D input
            tinfo.set_delays(this.d.get_timing_info());
        }

        return tinfo;
    };

    Storage.prototype.get_clock_info = function(clk) {
        if (this.type == 'dreg') {
            // account for setup and hold times
            var tinfo = new TimingInfo(clk.name+'\u2191',clk,this,-this.th,this.ts);
            tinfo.set_delays(this.d.get_timing_info());
            return tinfo;
        };
        return undefined;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Memories
    //
    ///////////////////////////////////////////////////////////////////////////////

    function Memory(network, name, properties, options) {
        var mem = this;
        mem.network = network;
        mem.name = name;

        // set up properties
        mem.width = properties.width;
        if (mem.width === undefined || mem.width <= 0)
            throw "Memory "+name+" must have width > 0.";
        mem.nlocations = properties.nlocations;
        if (mem.nlocations === undefined || mem.nlocations <= 0)
            throw "Memory "+name+" must have > 0 locations.";
        mem.contents = properties.contents;

        mem.lenient = properties.lenient !== undefined && properties.lenient !== 0;
        mem.cout = properties.cout || options.mem_cout || 0;
        mem.cin = properties.cin || options.mem_cin || .1e-12;
        mem.tcd = properties.tcd || options.mem_tcd || 0;
        mem.tr = properties.tr || options.mem_tr || 1000;  // ns/pf
        mem.tf = properties.tf || options.mem_tf || 1000;  // ns/pf
        mem.ts = properties.ts || options.mem_ts || 0;
        mem.th = properties.th || options.mem_th || 0;

        // tPD depends on number of memory locations
        // local properties take precedence over global options
        if (mem.nlocations > 1024) {          // dram
            mem.tpdf = properties.tpdf || properties.tpd ||
                options.mem_tpdf_dram || options.mem_tpd_dram || 40e-9;
            mem.tpdr = properties.tpdr || properties.tpd ||
                options.mem_tpdr_dram || options.mem_tpd_dram || 40e-8;
        } else if (mem.nlocations > 128) {   // sram
            mem.tpdf = properties.tpdf || properties.tpd ||
                options.mem_tpdf_sram || options.mem_tpd_sram || 2e-9;
            mem.tpdr = properties.tpdr || properties.tpd ||
                options.mem_tpdr_sram || options.mem_tpd_sram || 2e-9;
        } else {                             // regfile
            mem.tpdf = properties.tpdf || properties.tpd ||
                options.mem_tpdf_regfile || options.mem_tpd_regfile || .1e-9;
            mem.tpdr = properties.tpdr || properties.tpd ||
                options.mem_tpdr_regfile || options.mem_tpd_regfile || .1e-9;
        }

        // set up fanouts and drivers
        mem.ports = properties.ports || [];
        mem.tristate_outputs = [];   // remember which nodes memory can drive
        mem.n_read_ports = 0;
        mem.n_write_ports = 0;
        mem.naddr = 0;
        $.each(mem.ports, function (i,port) {
            // we listen to clk, wen, oe and addr signals
            port.clk.add_fanout(mem);
            port.wen.add_fanout(mem);
            port.oe.add_fanout(mem);
            $.each(port.addr, function (j, node) { node.add_fanout(mem); });
            mem.naddr = port.addr.length;

            $.each(port.data, function (j, node) {
                // if there's a possibility of a write, we listen to data nodes
                if (port.clk != network.gnd || port.wen != network.gnd) {
                    node.add_fanout(mem);
                    mem.n_write_ports += 1;
                    port.write_port = true;
                }

                // if there's a possibility of a read, add data nodes as drivers
                if (port.oe != network.gnd) {
                    node.add_driver(mem);
                    if (mem.tristate_outputs.indexOf(node) != -1) mem.tristate_outputs.push(node);
                    mem.n_read_ports += 1;
                    port.read_port = true;
                }
            });
        });

        // allocate internal storage array, one location per bit since we're lazy
        mem.bits = new Uint8Array(mem.nlocations * mem.width);  // array of memory bits

        // compute size
        var cell;   // size of each storage cell (not including access fet)
        if (mem.n_read_ports == 1 && mem.n_write_ports == 0)  // ROM
            cell = 0;
        else if (mem.nlocations <= 1024)   // SRAM
            cell = options.mem_size_sram || 5;
        else cell = 0; // DRAM
        // add 1 access fet per port
        cell += mem.ports.length * (options.mem_size_access || 1);

        // start with storage cell area = number of bits * cell size
        // (1 access fet per port + size of storage cell)
        var size = (mem.nlocations * mem.width) * cell;
        // size of address buffers
        size += mem.ports.length * mem.naddr * (options.mem_size_address_buffer || 20);
        // size of address decoders (assuming 4-input ands)
        size += mem.ports.length * mem.naddr * (options.mem_size_address_decoder || 20);
        // size of tristate output drivers
        size += mem.n_read_ports * mem.width * (options.mem_size_output_buffer || 30);
        // size of write data drivers
        size += mem.n_write_ports * mem.width * (options.mem_size_write_buffer || 20);

        network.size += size;
    }

    // set all memory locations to X
    Memory.prototype.clear_memory = function () {
        var nbits = this.nlocations * this.width;
        for (var i = 0; i < nbits; i += 1) this.bits[i] = VX;
    };

    Memory.prototype.initialize = function() {
        this.min_setup = undefined;     // min observed setup time on inputs
        this.min_setup_time = undefined;  // when min observed setup was observer

        this.clear_memory();  // start with all X's

        // did user specify initial contents?
        if (this.contents !== undefined) {
            var nlocations = Math.min(this.nlocations,this.contents.length);
            for (var i = 0; i < nlocations; i += 1) {
                var word = this.contents[i];
                for (var j = 0; j < this.width; j += 1, word >>= 1)
                    this.bits[i*this.width + j] = word & 1;
            }
        }
    };

    Memory.prototype.update_min_setup = function(node) {
        var now = this.network.time;
        if (now > 0) {
            var ntime = node.last_event_time();
            if (ntime !== undefined) {
                var tsetup = now - ntime;
                if (this.min_setup === undefined || tsetup < this.min_setup) {
                    this.min_setup = tsetup;
                    this.min_setup_time = now;
                }
            }
        }
    };

    // compute address from a port's addr signals, -1 if invalid.
    // set update to true to update min setup time
    Memory.prototype.address = function(port,update) {
        var addr = 0;
        var node,v;
        for (var i = 0; i < this.naddr; i += 1) {
            node = port.addr[i];
            if (update) this.update_min_setup(node);
            v = node.v;
            if (v == VX || v == VZ) addr = -1;
            else if (addr >= 0) {
                addr <<= 1;
                if (v == V1) addr |= 1;
            }
        }
        return addr;
    };

    // return true if this a read port that is affecting its outputs
    Memory.prototype.active_read_port = function(port,cause) {
        // make sure it's a read port
        if (!port.read_port) return false;

        // port is active if OE just changed or OE != 0 and
        // some address input just changed
        if (cause == port.oe) return true;
        if (port.oe.v != V0 && port.addr.indexOf(cause) != -1) return true;
        return false;
    };

    // schedule propagtion events for data terminals of a read port
    Memory.prototype.update_read_port = function(port) {
        var addr = this.address(port,false);
        var table = TristateBufferTable[port.oe.v];  // model of tristate driver
        for (var i = 0; i < this.width; i += 1) {
            // MSB of data comes first in the array of data nodes
            var bit = (this.width - 1) - i;
            var v = (addr < 0 || addr >= this.nlocations) ? VX : this.bits[addr*this.width + bit];
            v = table[v][4];   // run it through the tristate driver, get result
            var drive,tpd;
            if (v == V1) { tpd = this.tpdr; drive = this.tr; }
            else if (v == V0) { tpd = this.tpdf; drive = this.tf; }
            else { tpd = Math.min(this.tpdr,this.tpdf); drive = 0; }
            port.data[i].p_event(tpd,v,drive,this.lenient);
        }
    };

    // memory location has changed, update read ports looking at that location
    Memory.prototype.location_changed = function(addr) {
        for (var i = 0; i < this.ports.length; i += 1) {
            var port = this.ports[i];
            if (port.read_port && port.oe.v != V0) {
                var paddr = this.address(port);
                // check for address match (X's always match)
                if (addr < 0 || paddr < 0 || paddr == addr)
                    this.update_read_port(port);
            }
        };
    };

    // return true if this a write port that should capture a new data value
    Memory.prototype.active_write_port = function(port,cause) {
        // make sure it's a write port
        if (!port.write_port) return false;

        if (this.network.time === 0) return false;
        if (cause == port.clk && port.clk.v != V0 && port.wen.v != V0) return true;
        return false;
    };

    Memory.prototype.capacitance = function(node) {
        var mem = this;
        var c = 0;
        // check each port to see if node is connected to one of its terminals
        $.each(mem.ports, function (i,port) {
            if (port.clk == node) c += mem.cin;
            if (port.wen == node) c += mem.cin;
            if (port.oe == node) c += mem.cin;
            $.each(port.addr, function (j, dnode) { if (dnode == node) c += mem.cin; });
            $.each(port.data, function (j, dnode) {
                if (dnode == node) {
                    // if there's a possibility of a write, data node is an input
                    if (port.clk != mem.network.gnd || port.wen != mem.network.gnd) c += mem.cin;

                    // if there's a possibility of a read, data node is an output
                    if (port.oe != mem.network.gnd) c += mem.cout;
                }
            });
        });
        return c;
    };

    // is node a tristate output of this device?
    Memory.prototype.tristate = function(node) {
        return this.tristate_outputs.indexOf(node) != -1;
    };

    // evaluation of output values triggered by an event on the input
    Memory.prototype.process_event = function(event,cause) {
        var i,bit,port;

        if (event.type == CONTAMINATE) {
            // look for port outputs affected by cause node
            for (i = 0; i < this.ports.length; i += 1) {
                port = this.ports[i];
                // only read ports have outputs to contaminate
                if (this.active_read_port(port,cause)) {
                    // data pins on port are affected by cause
                    for (bit = 0; bit < this.width; bit += 1)
                        port.data[bit].c_event(this.tcd);
                }
            };
        } else if (event.type == PROPAGATE) {   // PROPAGATE event
            // look for port outputs affected by cause node
            for (i = 0; i < this.ports.length; i += 1) {
                port = this.ports[i];

                if (this.active_read_port(port,cause))
                    this.update_read_port(port);

                if (this.active_write_port(port,cause)) {
                    var addr = this.address(port,true);
                    // will write store a value or X?
                    var valid = (port.clk.v == V1) && (port.wen.v == V1);
                    // write appropriate location(s)
                    if (addr < 0) this.clear_memory();
                    else if (addr < this.nlocations) {
                        for (bit = 0; bit < this.width; bit += 1)
                            // MSB of data comes first in the array of data nodes
                            this.bits[addr*this.width + (this.width - 1) - bit] = valid ? port.data[bit].v : VX;
                    }
                    this.location_changed(addr);
                }
            };
        }
    };

    Memory.prototype.get_timing_info = function(output) {
        return undefined;
    };

    Memory.prototype.get_clock_info = function(clk) {
        return undefined;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Timing info generated during timing analysis
    //
    ///////////////////////////////////////////////////////////////////////////////

    function TimingInfo(name,node,device,tcd,tpd) {
        this.name = name;  // name to use in reports (sometimes differs from node.name)
        this.node = node;  // associated node
        this.device = device;  // what device determined this info

        this.cd_sum = 0;  // min cummulative tCD from inputs to here
        this.cd_link = undefined;  // previous TimingInfo in tCD path
        this.pd_sum = 0;  // max cummulative tPD from inputs to here
        this.pd_link = undefined;  // previous TimingInfo in tPD path

        this.tcd = tcd || 0;  // specs for driving gate, capacitance accounted for
        this.tpd = tpd || 0;
    }

    TimingInfo.prototype.get_tcd_source = function () {
        var t = this;
        while (t.cd_link !== undefined) t = t.cd_link;
        return {node: t.node, name: t.name};
    };

    TimingInfo.prototype.get_tpd_source = function () {
        var t = this;
        while (t.pd_link !== undefined) t = t.pd_link;
        return {node: t.node, name: t.name};
    };

    // using timing info from an input, updated timing info for associated node
    TimingInfo.prototype.set_delays = function (tinfo) {
        var t;

        // update min tCD
        t = tinfo.cd_sum + this.tcd;
        if (this.cd_link === undefined || t < this.cd_sum) {
            this.cd_link = tinfo;
            this.cd_sum = t;
        }

        // update max tPD
        t = tinfo.pd_sum + this.tpd;
        if (this.pd_link === undefined || t > this.pd_sum) {
            this.pd_link = tinfo;
            this.pd_sum = t;
        }
    };

    function format_float(n,width,decimal_places) {                                                        
        var result = n.toFixed(decimal_places);                                                            
        while (result.length < width) result = ' '+result;                                                 
        return result;                                                                                             
    }                                                                                                      
          
    // recursively describe tPD path
    TimingInfo.prototype.describe_tpd = function () {
        var result;
        if (this.pd_link !== undefined) result = this.pd_link.describe_tpd();
        else result = '';

        var driver_name = (this.device !== undefined) ? ' ['+this.device.name+']' : '';
        result += '    + '+format_float(this.tpd*1e9,6,3)+"ns = "+format_float(this.pd_sum*1e9,6,3)+"ns "+this.name+driver_name+'\n';
        return result;
    };

    // recursively describe tCD path
    TimingInfo.prototype.describe_tcd = function () {
        var result;
        if (this.cd_link !== undefined) result = this.cd_link.describe_tcd();
        else result = '';

        var driver_name = (this.device !== undefined) ? ' ['+this.device.name+']' : '';
        // when calculating hold time violations, tcd for register is negative...
        result += '    '+(this.tcd < 0 ? '-' : '+');
        result += ' '+format_float(Math.abs(this.tcd)*1e9,6,3)+"ns = "+format_float(this.cd_sum*1e9,6,3)+"ns "+this.name+driver_name+'\n';
        return result;
    };

    ///////////////////////////////////////////////////////////////////////////////
    //
    //  Module definition
    //
    ///////////////////////////////////////////////////////////////////////////////
    var module = {
        'dc_analysis': dc_analysis,
        'ac_analysis': ac_analysis,
        'transient_analysis': transient_analysis,
        'timing_analysis': timing_analysis
    };
    return module;
}());