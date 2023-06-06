interface LinkedNode<DataType> {
  data: DataType;
  next?: LinkedNode<DataType>;
}

export class LinkedList<DataType> {
  head?: LinkedNode<DataType>;
  tail?: LinkedNode<DataType>;
  
  public putAtBeginning(data: DataType) {
    if (this.head === undefined) {
      if (this.tail !== undefined) {
        throw new Error("Fatal error");
      }
      this.head = {
        data: data, 
      }
      this.tail = this.head;
    }
    else {
      if (this.tail === undefined) {
        throw new Error("Fatal error");
      }

      const newHead = {
        data: data,
        next: this.head
      };
      this.head = newHead;
    }
  }
  
  public pushAtEnd(data: DataType) {
    if (this.tail === undefined) {
      if (this.head !== undefined) {
        throw new Error("Fatal error");
      }
      this.head = {
        data: data, 
      }
      this.tail = this.head;
    }
    else {
      if (this.tail.next !== undefined) {
        throw new Error("Fatal error");
      }

      const newTail = {
        data: data
      };
      this.tail.next = newTail;
    }
  }

  public toArray(): DataType[] {
    const array = [];

    for (let index = this.head; index !== undefined && index?.next !== undefined; index = index.next) {
      array.push(index.data);
    }

    return array;
  }

}