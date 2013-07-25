BSim = {};

$(function() {
    var split = new SplitUI('#split-container', '#editor-pane', '#simulation-pane');
    split.maximiseLeft();

    var activeButton = function(callback) {
        return function() {
            $(this).siblings().removeClass('active');
            $(this).addClass('active');
            callback();
        };
    }

    // Set up the split buttons.
    $('#maximise_editor').click(activeButton(split.maximiseLeft));
    $('#split_pane').click(activeButton(split.split));
    $('#maximise_simulation').click(activeButton(split.maximiseRight));


    // Make an editor
    var editor = new Editor('#editor', 'uasm');

    // Filesystem tree thing
    FileSystem.setup('mattpf', 'https://6004.mattpf.net:6004/');
    Folders.setup('#filetree', editor, 'uasm');

    var do_assemble = function() {
        var filename = editor.currentTab();
        var content = editor.content();
        var assembler = new BetaAssembler();
        editor.clearErrors();
        assembler.assemble(filename, content, function(success, result) {
            if(!success) {
                _.each(result, function(error) {
                    if(!_.contains(editor.filenames(), error.file)) {
                        FileSystem.getFile(error.file, function(result) {
                            editor.openTab(error.file, result.data, true);
                            editor.markErrorLine(error.file, error.message, error.line - 1, error.column);
                        });
                    } else {
                        editor.markErrorLine(error.file, error.message, error.line - 1, error.column);
                    }
                });
            } else {
                beta.loadBytes(result.image);
                beta.setBreakpoints(result.breakpoints);
                beta.setLabels(result.labels);
                _.each(result.options, function(value, key) {
                    beta.setOption(key, value);
                });
                beta.getMemory().setProtectedRegions(result.protection);
                if(result.checkoff) {
                    if(result.checkoff.kind == 'tty') {
                        var verifier = new BSim.TextVerifier(beta, result.checkoff.checksum);
                        beta.setVerifier(verifier);
                    } else if(result.checkoff.kind == 'memory') {
                        var verifier = new BSim.MemoryVerifier(beta, result.checkoff.addresses, result.checkoff.checksum, result.checkoff.running_checksum);
                        beta.setVerifier(verifier);
                    }
                } else {
                    beta.setVerifier(null);
                }
                if(split.currentState() == 'left') {
                    $('#maximise_simulation').click();
                }
            }
        });
    }

    // Add some buttons to it
    editor.addButtonGroup([new ToolbarButton('Assemble', do_assemble, 'Runs your program!')]);
    // And a couple of tabs.
    editor.openTab(null, '');
    var set_height = function() {
        editor.setHeight(document.documentElement.clientHeight - 80); // Set height to window height minus title.
    }
    set_height();
    $(window).resize(set_height); // Update the height whenever the browser window changes size.

    // Stuff for the simulator

    var beta = new BSim.Beta(80); // This starting number is basically irrelevant

    $('.regfile').each(function() {
        new BSim.RegfileView(this, beta);
    });

    $('.program-controls').each(function() {
        new BSim.Controls(this, beta);
    });

    $('.tty').each(function() {
        new BSim.TTY(this, beta);
    });

    $('.disassembly').each(function() {
        new BSim.DisassembledView(this, beta);
    });

    $('.memory').each(function() {
        new BSim.MemoryView(this, beta);
    });

    $('.stack').each(function() {
        new BSim.StackView(this, beta);
    });

    new BSim.Beta.ErrorHandler(beta);
    new BSim.SchematicView($('svg.schematic'), beta);

    // // Convenient way of loading a file for testing and such.
    // var neuter = function(e) {
    //     e.stopPropagation();
    //     e.preventDefault();
    // };
    // $('body').on('dragenter', neuter);
    // $('body').on('dragover', neuter);
    // $('body').on('drop', function(e) {
    //     neuter(e);
    //     console.log(e);
    //     var dt = e.originalEvent.dataTransfer;
    //     var files = dt.files;

    //     if(files.length === 0) return;
    //     var file = files[0];
    //     beta.stop(); // Just in case.
    //     var reader = new FileReader();
    //     reader.onload = function(e) {
    //         console.log(e);
    //         //beta = new BSim.Beta(e.target.result.length);
    //         var result = new Uint8Array(e.target.result);
    //         beta.loadBytes(result);
    //         console.log("Loaded", result.length, "bytes");
    //     };
    //     reader.readAsArrayBuffer(file);
    // });

    // For debugging
    window.beta = beta;
});
