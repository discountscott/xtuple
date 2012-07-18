/*jshint node:true, indent:2, curly:true eqeqeq:true, immed:true, latedef:true, newcap:true, noarg:true,
regexp:true, undef:true, strict:true, trailing:true, white:true */
/*global XT:true, XV:true, enyo:true, _:true */
(function () {
  "use strict";

  enyo.kind({
    name: "XV.GridWidget",
    kind: enyo.Control,
    published: {
      models: null,
      descriptor: null
    },
    events: {
      onModelUpdate: ""
    },
    style: "height: 200px; width: 700px; margin-right: 5px; font-size: 12px;",
    components: [
      { kind: "onyx.GroupboxHeader", name: "title" }
    ],


    renderWidget: function () {
      var iField, iRow, boxRow, fieldDesc, label;
      var boxDesc = this.getDescriptor();

      /**
       * First set the title for the box
       */
      this.$.title.setContent(boxDesc.title);

      /**
       * Row -1 is the header row. This lets us neatly number the real rows
       * starting at zero.
       */
      for (iRow = -1; iRow < 8; iRow++) {
        /**
         * This is the row that all the fields will be put in.
         */
        boxRow = this.createComponent({
          kind: "onyx.Groupbox",
          classes: "onyx-toolbar-inline",
          style: "background-color: white;"
        });

        for (iField = 0; iField < boxDesc.fields.length; iField++) {
          fieldDesc = boxDesc.fields[iField];
          label = fieldDesc.label ? "_" + fieldDesc.label : "_" + fieldDesc.fieldName;
          if (iRow === -1) {
            /**
             * This is the label header at the top of each row
             */
            this.createComponent({
              container: boxRow,
              content: label.loc(),
              style: "text-weight: bold; border-width: 0px; width: " + fieldDesc.width + "px;"
            });
            continue;
          }
          /**
           * This is the label. The naming convention cribs from enyo's magical convention
           * XXX not sure if this is the best way to do it
           */
          this.createComponent({
            kind: XV.util.getFieldType(fieldDesc.fieldType),
            container: boxRow,
            placeholder: fieldDesc.label,
            style: "border-width: 0px; width: " + fieldDesc.width + "px; ",
            onchange: "doFieldChanged",
            name: fieldDesc.fieldName + iRow
          });
        }
      }
    },

    /**
     * A convenience function so that this object can be treated generally like an input
     */
    setValue: function (object) {
      this.setModels(object);
    },
    /**
     * A convenience function so that this object can be treated generally like an input
     */
    getValue: function () {
      return this.getModels();
    },
    /**
     * render this object onto the name field
     */
    modelsChanged: function () {
      for (var iRow = 0; iRow < this.getModels().length; iRow++) {
        var model = this.getModels().models[iRow];
        for (var iField = 0; iField < this.getDescriptor().fields.length; iField++) {
          var rowDescription = this.getDescriptor().fields[iField];
          this.$[rowDescription.fieldName + iRow].setValue(model.get(rowDescription.fieldName));
        }
      }
    },
    doFieldChanged: function (inSender, inEvent) {
      var fieldNameWithNumber = inSender.getName();
      var newValue = inSender.getValue();
      // split the field name into the (alpha) prefix and the (numeric) suffix
      // XXX here's where we make use of the magical naming convention

      // REGEX: capture an alpha prefix as well as a numeric suffix
      var fieldNameSplit = fieldNameWithNumber.match(/(\D+)(\d+)/);


      var rowIndex = Number(fieldNameSplit[2]);
      var fieldName = fieldNameSplit[1];

      var updateObject = {};
      updateObject[fieldName] = newValue;


      /**
       * Update the model. Or add a new model if it's a new grid row
       */
      if(rowIndex >= this.getModels().models.length) {
        // add
        var newModel = new XM.ProjectTask(updateObject); // FIXME can't hardcode ProjectTask
        this.getModels().models.push(newModel);
      } else {
        // update
        this.getModels().models[rowIndex].set(updateObject);
      }

      /**
       * Send up notice that there's been an update
       */
      this.doModelUpdate();
    }
  });
}());
